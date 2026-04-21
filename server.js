require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const XLSX = require("xlsx");

const Admin = require("./models/Admin");
const Student = require("./models/Student");
const Category = require("./models/Category");
const Nominee = require("./models/Nominee");
const Vote = require("./models/Vote");

const app = express();
const adminSessions = new Map();
const PORT = Number(process.env.PORT) || 5000;
const MONGODB_URI = process.env.MONGODB_URI;
const DEFAULT_ADMIN_USERNAME = (process.env.DEFAULT_ADMIN_USERNAME || "admin").trim();
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || "admin123";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

app.set("trust proxy", 1);
app.use(express.json({ limit: "12mb" }));
app.use(cors());
app.use(express.static(__dirname));

if (!MONGODB_URI) {
  console.error("MongoDB Error: MONGODB_URI is not defined");
  process.exit(1);
}

mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("MongoDB Connected");
    await ensureDefaultAdmin();
  })
  .catch(error => {
    console.error("MongoDB Error:", error);
  });

function parseCookies(req) {
  const header = req.headers.cookie || "";

  return header.split(";").reduce((cookies, item) => {
    const [rawKey, ...rawValue] = item.trim().split("=");

    if (!rawKey) {
      return cookies;
    }

    cookies[rawKey] = decodeURIComponent(rawValue.join("="));
    return cookies;
  }, {});
}

function setAdminCookie(res, token) {
  const secureFlag = IS_PRODUCTION ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `admin_session=${token}; HttpOnly; Path=/; SameSite=Lax${secureFlag}`
  );
}

function clearAdminCookie(res) {
  const secureFlag = IS_PRODUCTION ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secureFlag}`
  );
}

function getAdminSession(req) {
  const token = parseCookies(req).admin_session;
  return token ? adminSessions.get(token) || null : null;
}

function requireAdmin(req, res, next) {
  const session = getAdminSession(req);

  if (!session) {
    return res.status(401).json({ message: "Admin login required" });
  }

  req.admin = session;
  next();
}

async function ensureDefaultAdmin() {
  const adminCount = await Admin.countDocuments();

  if (!adminCount) {
    await Admin.create({
      username: DEFAULT_ADMIN_USERNAME,
      password: DEFAULT_ADMIN_PASSWORD
    });
    console.log(`Default admin created: ${DEFAULT_ADMIN_USERNAME} / ${DEFAULT_ADMIN_PASSWORD}`);
  }
}

function getVoteRoundNumber(vote) {
  return Number(vote.roundNumber) || 1;
}

function buildRoundMatch(roundNumber) {
  if (Number(roundNumber) === 1) {
    return [{ roundNumber: 1 }, { roundNumber: { $exists: false } }];
  }

  return [{ roundNumber: Number(roundNumber) || 1 }];
}

async function getCategoryContestants(categoryId) {
  return Nominee.find({ categoryId }).sort({ name: 1, enrollmentNumber: 1 }).lean();
}

function getActiveCandidateIds(category, contestants) {
  if (Array.isArray(category.activeCandidateIds) && category.activeCandidateIds.length) {
    const available = new Set(contestants.map(contestant => contestant._id.toString()));
    return category.activeCandidateIds.filter(candidateId => available.has(candidateId));
  }

  return contestants.map(contestant => contestant._id.toString());
}

function buildVoteMap(votes) {
  return votes.reduce((map, vote) => {
    map[vote.nomineeId] = (map[vote.nomineeId] || 0) + 1;
    return map;
  }, {});
}

function normalizeSpreadsheetRows(rows) {
  return rows.reduce((payload, row) => {
    const normalizedKeys = Object.keys(row || {}).reduce((keys, key) => {
      keys[key.toLowerCase().replace(/\s+/g, "")] = row[key];
      return keys;
    }, {});

    const name = String(
      normalizedKeys.name ||
      normalizedKeys.studentname ||
      normalizedKeys.fullname ||
      ""
    ).trim();
    const enrollmentNumber = String(
      normalizedKeys.enrollmentnumber ||
      normalizedKeys.enrollment ||
      normalizedKeys.rollnumber ||
      normalizedKeys.admissionnumber ||
      ""
    ).trim();

    if (!name || !enrollmentNumber) {
      return payload;
    }

    payload.push({ name, enrollmentNumber });
    return payload;
  }, []);
}

function parseSpreadsheetPayload(body) {
  let rows = Array.isArray(body.students) ? body.students : [];

  if (!rows.length && body.fileContentBase64) {
    const fileBuffer = Buffer.from(body.fileContentBase64, "base64");
    const workbook = XLSX.read(fileBuffer, { type: "buffer" });
    const firstSheetName = workbook.SheetNames[0];
    const firstSheet = workbook.Sheets[firstSheetName];
    rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
  }

  return normalizeSpreadsheetRows(rows);
}

async function getRoundSnapshot(category) {
  const contestants = await getCategoryContestants(category._id.toString());
  const activeCandidateIds = getActiveCandidateIds(category, contestants);
  const activeIdSet = new Set(activeCandidateIds);
  const roundVotes = await Vote.find({
    categoryId: category._id.toString(),
    $or: buildRoundMatch(category.currentRoundNumber || 1)
  }).lean();
  const voteMap = buildVoteMap(roundVotes);

  const roundContestants = contestants
    .filter(contestant => activeIdSet.has(contestant._id.toString()))
    .map(contestant => ({
      ...contestant,
      votes: voteMap[contestant._id.toString()] || 0
    }))
    .sort((a, b) => {
      if (b.votes !== a.votes) {
        return b.votes - a.votes;
      }

      return a.name.localeCompare(b.name);
    });

  return {
    contestants,
    roundContestants,
    roundVotes
  };
}

async function replaceCategoryContestants(category, contestants) {
  const uniqueContestants = [];
  const seen = new Set();

  contestants.forEach(contestant => {
    const enrollmentNumber = String(contestant.enrollmentNumber || "").trim();
    const name = String(contestant.name || "").trim();

    if (!name || !enrollmentNumber || seen.has(enrollmentNumber)) {
      return;
    }

    seen.add(enrollmentNumber);
    uniqueContestants.push({ name, enrollmentNumber });
  });

  await Vote.deleteMany({ categoryId: category._id.toString() });
  await Nominee.deleteMany({ categoryId: category._id.toString() });

  const inserted = uniqueContestants.length
    ? await Nominee.insertMany(
        uniqueContestants.map(contestant => ({
          name: contestant.name,
          enrollmentNumber: contestant.enrollmentNumber,
          categoryId: category._id.toString()
        }))
      )
    : [];

  category.isActive = false;
  category.isRunoff = false;
  category.currentRoundNumber = 1;
  category.activeCandidateIds = inserted.map(contestant => contestant._id.toString());
  category.closedAt = null;
  category.winnerAnnounced = false;
  category.announcedAt = null;
  category.announcedWinners = [];
  await category.save();

  return {
    insertedCount: inserted.length,
    skippedCount: contestants.length - uniqueContestants.length
  };
}

async function buildCategoryResults() {
  const categories = await Category.find().sort({ name: 1 }).lean();
  const nominees = await Nominee.find().lean();
  const votes = await Vote.find().lean();

  return categories.map(category => {
    const currentRoundNumber = category.currentRoundNumber || 1;
    const categoryNominees = nominees.filter(
      nominee => nominee.categoryId === category._id.toString()
    );
    const activeCandidateIds = getActiveCandidateIds(category, categoryNominees);
    const activeIdSet = new Set(activeCandidateIds);
    const categoryVotes = votes.filter(vote => vote.categoryId === category._id.toString());
    const currentRoundVotes = categoryVotes.filter(
      vote => getVoteRoundNumber(vote) === currentRoundNumber
    );
    const voteMap = buildVoteMap(currentRoundVotes);

    const leaderboard = categoryNominees
      .filter(nominee => activeIdSet.has(nominee._id.toString()))
      .map(nominee => ({
        ...nominee,
        votes: voteMap[nominee._id.toString()] || 0
      }))
      .sort((a, b) => {
        if (b.votes !== a.votes) {
          return b.votes - a.votes;
        }

        return a.name.localeCompare(b.name);
      });

    const highestVotes = leaderboard.length ? leaderboard[0].votes : 0;
    const currentLeaders = leaderboard.filter(
      nominee => nominee.votes === highestVotes && highestVotes > 0
    );

    return {
      ...category,
      contestantCount: categoryNominees.length,
      totalVotes: categoryVotes.length,
      currentRoundVotes: currentRoundVotes.length,
      nominees: leaderboard,
      currentLeaders
    };
  });
}

async function buildParticipation() {
  const students = await Student.find().sort({ enrollmentNumber: 1 }).lean();
  const categories = await Category.find().sort({ name: 1 }).lean();
  const votes = await Vote.find().lean();

  const activeCategory = categories.find(category => category.isActive) || null;
  const pausedCategory = categories
    .filter(category => !category.isActive && category.closedAt)
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))[0] || null;

  const votesByStudent = votes.reduce((map, vote) => {
    if (!map[vote.enrollmentNumber]) {
      map[vote.enrollmentNumber] = [];
    }

    map[vote.enrollmentNumber].push(vote);
    return map;
  }, {});

  return students.map(student => {
    const studentVotes = votesByStudent[student.enrollmentNumber] || [];
    const votedCategoryIds = [...new Set(studentVotes.map(vote => vote.categoryId))];
    const hasLoggedIn = Boolean(student.lastLoginAt);
    const activeRoundNumber = activeCategory?.currentRoundNumber || 1;
    const pausedRoundNumber = pausedCategory?.currentRoundNumber || 1;
    const hasVotedInActiveRound = activeCategory
      ? studentVotes.some(
          vote =>
            vote.categoryId === activeCategory._id.toString() &&
            getVoteRoundNumber(vote) === activeRoundNumber
        )
      : false;
    const hasVotedInPausedRound = pausedCategory
      ? studentVotes.some(
          vote =>
            vote.categoryId === pausedCategory._id.toString() &&
            getVoteRoundNumber(vote) === pausedRoundNumber
        )
      : false;

    let currentStatus = "Waiting for next round";

    if (!hasLoggedIn) {
      currentStatus = "Never logged in";
    } else if (activeCategory && !hasVotedInActiveRound) {
      currentStatus = "Logged in, pending current round";
    } else if (activeCategory && hasVotedInActiveRound) {
      currentStatus = "Voted in current round";
    } else if (pausedCategory && hasVotedInPausedRound) {
      currentStatus = "Voted in paused round";
    } else if (pausedCategory && !hasVotedInPausedRound) {
      currentStatus = "Missed paused round";
    } else if (studentVotes.length) {
      currentStatus = "Voted in completed rounds";
    }

    return {
      ...student,
      hasLoggedIn,
      votedCategoryIds,
      totalVotesCast: studentVotes.length,
      hasVotedInActiveRound,
      currentStatus
    };
  });
}

async function setActiveCategory(categoryId) {
  const category = await Category.findById(categoryId);

  if (!category) {
    return null;
  }

  const contestants = await getCategoryContestants(category._id.toString());
  const candidateIds = getActiveCandidateIds(category, contestants);

  if (!candidateIds.length) {
    throw new Error("No class list uploaded for this category");
  }

  await Category.updateMany({}, { $set: { isActive: false } });

  category.isActive = true;
  category.closedAt = null;
  category.activeCandidateIds = candidateIds;
  await category.save();

  return category;
}

async function buildStudentRoundState(enrollmentNumber) {
  const categories = await Category.find().lean();
  const activeCategory = categories.find(category => category.isActive) || null;
  const latestClosedCategory = categories
    .filter(category => category.closedAt)
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))[0] || null;
  const latestAnnouncement = categories
    .filter(
      category =>
        category.winnerAnnounced &&
        category.announcedAt &&
        Array.isArray(category.announcedWinners) &&
        category.announcedWinners.length
    )
    .sort((a, b) => new Date(b.announcedAt) - new Date(a.announcedAt))[0] || null;

  let activeVote = null;
  let pausedVote = null;
  let nominees = [];

  if (activeCategory) {
    const snapshot = await getRoundSnapshot(activeCategory);
    nominees = snapshot.roundContestants.map(contestant => ({
      _id: contestant._id,
      name: contestant.name,
      enrollmentNumber: contestant.enrollmentNumber,
      votes: contestant.votes
    }));
  }

  if (enrollmentNumber) {
    const relevantCategoryIds = [activeCategory?._id, latestClosedCategory?._id]
      .filter(Boolean)
      .map(value => value.toString());

    const votes = relevantCategoryIds.length
      ? await Vote.find({
          enrollmentNumber,
          categoryId: { $in: relevantCategoryIds }
        }).lean()
      : [];

    if (activeCategory) {
      const activeRoundNumber = activeCategory.currentRoundNumber || 1;
      const activeVoteRecord = votes.find(
        vote =>
          vote.categoryId === activeCategory._id.toString() &&
          getVoteRoundNumber(vote) === activeRoundNumber
      );

      if (activeVoteRecord) {
        activeVote = {
          nomineeId: activeVoteRecord.nomineeId
        };
      }
    }

    if (latestClosedCategory) {
      const pausedRoundNumber = latestClosedCategory.currentRoundNumber || 1;
      const pausedVoteRecord = votes.find(
        vote =>
          vote.categoryId === latestClosedCategory._id.toString() &&
          getVoteRoundNumber(vote) === pausedRoundNumber
      );

      if (pausedVoteRecord) {
        const pausedNominee = await Nominee.findById(pausedVoteRecord.nomineeId).lean();

        pausedVote = {
          nomineeId: pausedVoteRecord.nomineeId,
          nomineeName: pausedNominee?.name || "Selected student",
          enrollmentNumber: pausedNominee?.enrollmentNumber || ""
        };
      }
    }
  }

  return {
    activeCategory: activeCategory
      ? {
          _id: activeCategory._id,
          name: activeCategory.name,
          currentRoundNumber: activeCategory.currentRoundNumber || 1,
          isRunoff: Boolean(activeCategory.isRunoff),
          studentListLabel: activeCategory.studentListLabel || ""
        }
      : null,
    nominees,
    activeVote,
    pausedCategory: !activeCategory && latestClosedCategory
      ? {
          _id: latestClosedCategory._id,
          name: latestClosedCategory.name,
          closedAt: latestClosedCategory.closedAt,
          currentRoundNumber: latestClosedCategory.currentRoundNumber || 1,
          isRunoff: Boolean(latestClosedCategory.isRunoff),
          winnerAnnounced: Boolean(latestClosedCategory.winnerAnnounced)
        }
      : null,
    pausedVote,
    latestAnnouncement: latestAnnouncement
      ? {
          categoryId: latestAnnouncement._id,
          categoryName: latestAnnouncement.name,
          announcedAt: latestAnnouncement.announcedAt,
          winners: latestAnnouncement.announcedWinners
        }
      : null
  };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin", (req, res) => {
  if (getAdminSession(req)) {
    return res.redirect("/admin/dashboard");
  }

  res.sendFile(path.join(__dirname, "admin-login.html"));
});

app.get("/admin/dashboard", (req, res) => {
  if (!getAdminSession(req)) {
    return res.redirect("/admin");
  }

  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/results", (req, res) => {
  if (!getAdminSession(req)) {
    return res.redirect("/admin");
  }

  res.sendFile(path.join(__dirname, "results.html"));
});

app.get("/admin/session", (req, res) => {
  const session = getAdminSession(req);

  if (!session) {
    return res.status(401).json({ message: "Not logged in" });
  }

  res.json({ username: session.username });
});

app.post("/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username: (username || "").trim() });

    if (!admin || admin.password !== password) {
      return res.status(401).json({ message: "Invalid admin credentials" });
    }

    const token = crypto.randomBytes(24).toString("hex");
    adminSessions.set(token, {
      adminId: admin._id.toString(),
      username: admin.username
    });

    setAdminCookie(res, token);
    res.json({ message: "Admin login successful" });
  } catch (error) {
    res.status(500).json({ message: "Admin login failed" });
  }
});

app.post("/admin/logout", (req, res) => {
  const token = parseCookies(req).admin_session;

  if (token) {
    adminSessions.delete(token);
  }

  clearAdminCookie(res);
  res.json({ message: "Logged out successfully" });
});

app.post("/admin/change-password", requireAdmin, async (req, res) => {
  try {
    const currentPassword = req.body.currentPassword || "";
    const newPassword = req.body.newPassword || "";

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        message: "Current password and new password are required"
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        message: "New password must be at least 6 characters"
      });
    }

    const admin = await Admin.findById(req.admin.adminId);

    if (!admin || admin.password !== currentPassword) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    admin.password = newPassword;
    await admin.save();

    res.json({ message: "Admin password changed successfully" });
  } catch (error) {
    res.status(500).json({ message: "Could not change password" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const enrollmentNumber = (req.body.enrollmentNumber || "").trim();
    const student = await Student.findOne({ enrollmentNumber });

    if (!student) {
      return res.status(400).json({ message: "Invalid enrollment number" });
    }

    student.lastLoginAt = new Date();
    await student.save();

    res.json({
      _id: student._id,
      name: student.name,
      enrollmentNumber: student.enrollmentNumber
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/student/active-round", async (req, res) => {
  try {
    const activeCategory = await Category.findOne({ isActive: true }).lean();

    if (!activeCategory) {
      return res.json({ activeCategory: null });
    }

    res.json({
      activeCategory: {
        _id: activeCategory._id,
        name: activeCategory.name,
        currentRoundNumber: activeCategory.currentRoundNumber || 1,
        isRunoff: Boolean(activeCategory.isRunoff)
      }
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching active round" });
  }
});

app.get("/student/round-state", async (req, res) => {
  try {
    const enrollmentNumber = (req.query.enrollmentNumber || "").trim();
    const roundState = await buildStudentRoundState(enrollmentNumber);
    res.json(roundState);
  } catch (error) {
    res.status(500).json({ message: "Error fetching student round state" });
  }
});

app.get("/student/active-round/nominees", async (req, res) => {
  try {
    const activeCategory = await Category.findOne({ isActive: true }).lean();

    if (!activeCategory) {
      return res.json({
        activeCategory: null,
        nominees: []
      });
    }

    const snapshot = await getRoundSnapshot(activeCategory);

    res.json({
      activeCategory: {
        _id: activeCategory._id,
        name: activeCategory.name,
        currentRoundNumber: activeCategory.currentRoundNumber || 1,
        isRunoff: Boolean(activeCategory.isRunoff)
      },
      nominees: snapshot.roundContestants
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching active round nominees" });
  }
});

app.get("/categories", async (req, res) => {
  try {
    const categories = await Category.find().sort({ name: 1 }).lean();
    const nominees = await Nominee.find({}, { categoryId: 1 }).lean();
    const counts = nominees.reduce((map, nominee) => {
      map[nominee.categoryId] = (map[nominee.categoryId] || 0) + 1;
      return map;
    }, {});

    res.json(
      categories.map(category => ({
        ...category,
        contestantCount: counts[category._id.toString()] || 0
      }))
    );
  } catch (error) {
    res.status(500).json({ message: "Error fetching categories" });
  }
});

app.get("/nominees/:categoryId", async (req, res) => {
  try {
    const nominees = await Nominee.find({
      categoryId: req.params.categoryId
    }).sort({ name: 1, enrollmentNumber: 1 });

    res.json(nominees);
  } catch (error) {
    res.status(500).json({ message: "Error fetching nominees" });
  }
});

app.post("/vote", async (req, res) => {
  try {
    const enrollmentNumber = (req.body.enrollmentNumber || "").trim();
    const { categoryId } = req.body;
    const nomineeId = req.body.nomineeId || req.body.candidateId;

    const student = await Student.findOne({ enrollmentNumber });
    if (!student) {
      return res.status(400).json({ message: "Student not allowed to vote" });
    }

    const category = await Category.findById(categoryId).lean();
    if (!category || !category.isActive) {
      return res.status(400).json({ message: "This round is not active right now" });
    }

    const snapshot = await getRoundSnapshot(category);
    const validCandidateIds = new Set(snapshot.roundContestants.map(contestant => contestant._id.toString()));

    if (!validCandidateIds.has(String(nomineeId || ""))) {
      return res.status(400).json({ message: "Selected student is not valid for this round" });
    }

    const currentRoundNumber = category.currentRoundNumber || 1;
    const existingVote = await Vote.findOne({
      enrollmentNumber: student.enrollmentNumber,
      categoryId,
      $or: buildRoundMatch(currentRoundNumber)
    });

    if (existingVote) {
      return res.status(400).json({ message: "Already voted in this round" });
    }

    await Vote.create({
      enrollmentNumber: student.enrollmentNumber,
      categoryId,
      nomineeId,
      roundNumber: currentRoundNumber
    });

    res.json({ message: "Vote submitted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Voting error" });
  }
});

app.get("/admin/students", requireAdmin, async (req, res) => {
  try {
    const students = await Student.find().sort({ enrollmentNumber: 1 });
    res.json(students);
  } catch (error) {
    res.status(500).json({ message: "Error fetching students" });
  }
});

app.post("/admin/students", requireAdmin, async (req, res) => {
  try {
    const { name, enrollmentNumber } = req.body;

    if (!name || !name.trim() || !enrollmentNumber || !enrollmentNumber.trim()) {
      return res.status(400).json({
        message: "Student name and enrollment number are required"
      });
    }

    const existingStudent = await Student.findOne({
      enrollmentNumber: enrollmentNumber.trim()
    });

    if (existingStudent) {
      return res.status(400).json({ message: "Enrollment number already exists" });
    }

    const student = await Student.create({
      name: name.trim(),
      enrollmentNumber: enrollmentNumber.trim()
    });

    res.status(201).json(student);
  } catch (error) {
    res.status(500).json({ message: "Could not create student" });
  }
});

app.post("/admin/students/import", requireAdmin, async (req, res) => {
  try {
    const students = parseSpreadsheetPayload(req.body);

    if (!students.length) {
      return res.status(400).json({ message: "No students found in uploaded list" });
    }

    const existingEnrollmentNumbers = new Set(
      (await Student.find({}, { enrollmentNumber: 1 }).lean()).map(student => student.enrollmentNumber)
    );

    const uniquePayload = [];
    const seen = new Set();

    students.forEach(student => {
      if (
        existingEnrollmentNumbers.has(student.enrollmentNumber) ||
        seen.has(student.enrollmentNumber)
      ) {
        return;
      }

      seen.add(student.enrollmentNumber);
      uniquePayload.push(student);
    });

    if (uniquePayload.length) {
      await Student.insertMany(uniquePayload);
    }

    res.json({
      message: `Imported ${uniquePayload.length} voter(s)`,
      importedCount: uniquePayload.length,
      skippedCount: students.length - uniquePayload.length
    });
  } catch (error) {
    res.status(500).json({ message: "Could not import students" });
  }
});

app.delete("/admin/students/:id", requireAdmin, async (req, res) => {
  try {
    const student = await Student.findById(req.params.id);

    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    await Vote.deleteMany({ enrollmentNumber: student.enrollmentNumber });
    await Student.findByIdAndDelete(req.params.id);

    res.json({ message: "Student deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Could not delete student" });
  }
});

app.get("/admin/participation", requireAdmin, async (req, res) => {
  try {
    const categories = await Category.find().sort({ name: 1 }).lean();
    const activeCategory = categories.find(category => category.isActive) || null;
    const participation = await buildParticipation();

    res.json({
      activeCategory,
      students: participation
    });
  } catch (error) {
    res.status(500).json({ message: "Could not load participation" });
  }
});

app.post("/admin/categories", requireAdmin, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const studentListLabel = (req.body.studentListLabel || "").trim();

    if (!name) {
      return res.status(400).json({ message: "Category name is required" });
    }

    const existingCategory = await Category.findOne({ name });
    if (existingCategory) {
      return res.status(400).json({ message: "Category already exists" });
    }

    const category = await Category.create({
      name,
      studentListLabel,
      isActive: false,
      closedAt: null
    });

    res.status(201).json(category);
  } catch (error) {
    res.status(500).json({ message: "Could not create category" });
  }
});

app.put("/admin/categories/:id", requireAdmin, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const studentListLabel = (req.body.studentListLabel || "").trim();

    if (!name) {
      return res.status(400).json({ message: "Category name is required" });
    }

    const duplicateCategory = await Category.findOne({
      _id: { $ne: req.params.id },
      name
    });

    if (duplicateCategory) {
      return res.status(400).json({ message: "Category already exists" });
    }

    const category = await Category.findByIdAndUpdate(
      req.params.id,
      { $set: { name, studentListLabel } },
      { new: true }
    );

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    res.json(category);
  } catch (error) {
    res.status(500).json({ message: "Could not update category" });
  }
});

app.delete("/admin/categories/:id", requireAdmin, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    await Vote.deleteMany({ categoryId: category._id.toString() });
    await Nominee.deleteMany({ categoryId: category._id.toString() });

    await Category.findByIdAndDelete(req.params.id);

    res.json({ message: "Category deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Could not delete category" });
  }
});

app.post("/admin/categories/:id/activate", requireAdmin, async (req, res) => {
  try {
    const category = await setActiveCategory(req.params.id);

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    res.json({ message: `${category.name} is now the active round`, category });
  } catch (error) {
    res.status(400).json({ message: error.message || "Could not activate round" });
  }
});

app.post("/admin/categories/:id/close", requireAdmin, async (req, res) => {
  try {
    const category = await Category.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          isActive: false,
          closedAt: new Date()
        }
      },
      { new: true }
    );

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    res.json({ message: `${category.name} has been closed`, category });
  } catch (error) {
    res.status(500).json({ message: "Could not close round" });
  }
});

app.post("/admin/categories/:id/announce-winner", requireAdmin, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    const snapshot = await getRoundSnapshot(category.toObject());

    if (!snapshot.roundContestants.length || snapshot.roundContestants[0].votes <= 0) {
      return res.status(400).json({ message: "No winner can be announced yet" });
    }

    const topVotes = snapshot.roundContestants[0].votes;
    const winners = snapshot.roundContestants.filter(contestant => contestant.votes === topVotes);

    if (winners.length > 1) {
      await Category.updateMany({}, { $set: { isActive: false } });

      category.winnerAnnounced = false;
      category.announcedAt = null;
      category.announcedWinners = [];
      category.isActive = true;
      category.closedAt = null;
      category.isRunoff = true;
      category.currentRoundNumber = (category.currentRoundNumber || 1) + 1;
      category.activeCandidateIds = winners.map(winner => winner._id.toString());
      await category.save();

      return res.json({
        message: `Draw detected. Runoff round ${category.currentRoundNumber} is now live for ${category.name}.`,
        category
      });
    }

    category.winnerAnnounced = true;
    category.announcedAt = new Date();
    category.announcedWinners = winners.map(winner => ({
      nomineeId: winner._id.toString(),
      name: winner.name,
      enrollmentNumber: winner.enrollmentNumber,
      votes: winner.votes
    }));
    category.isActive = false;
    category.closedAt = new Date();
    category.isRunoff = false;
    await category.save();

    res.json({
      message: `Winner announced for ${category.name}`,
      category
    });
  } catch (error) {
    res.status(500).json({ message: "Could not announce winner" });
  }
});

app.get("/admin/nominees", requireAdmin, async (req, res) => {
  try {
    const categories = await Category.find().lean();
    const nominees = await Nominee.find().lean();

    const categoryMap = new Map(
      categories.map(category => [category._id.toString(), category.name])
    );

    res.json(
      nominees
        .map(nominee => ({
          ...nominee,
          categoryName: categoryMap.get(nominee.categoryId) || "Unassigned"
        }))
        .sort((a, b) => {
          const categoryCompare = a.categoryName.localeCompare(b.categoryName);

          if (categoryCompare !== 0) {
            return categoryCompare;
          }

          return a.name.localeCompare(b.name);
        })
    );
  } catch (error) {
    res.status(500).json({ message: "Error fetching nominees" });
  }
});

app.get("/admin/categories/:id/contestants", requireAdmin, async (req, res) => {
  try {
    const contestants = await getCategoryContestants(req.params.id);
    res.json(contestants);
  } catch (error) {
    res.status(500).json({ message: "Could not load class list" });
  }
});

app.get("/admin/class-list-presets", requireAdmin, async (req, res) => {
  try {
    const categories = await Category.find().sort({ name: 1 }).lean();
    const nominees = await Nominee.find({}, { categoryId: 1 }).lean();
    const counts = nominees.reduce((map, nominee) => {
      map[nominee.categoryId] = (map[nominee.categoryId] || 0) + 1;
      return map;
    }, {});

    res.json(
      categories
        .map(category => ({
          _id: category._id,
          name: category.name,
          studentListLabel: category.studentListLabel || "",
          contestantCount: counts[category._id.toString()] || 0
        }))
        .filter(category => category.contestantCount > 0)
    );
  } catch (error) {
    res.status(500).json({ message: "Could not load class list presets" });
  }
});

app.post("/admin/categories/:id/contestants/import", requireAdmin, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    const contestants = parseSpreadsheetPayload(req.body);

    if (!contestants.length) {
      return res.status(400).json({ message: "No students found in uploaded class list" });
    }
    const result = await replaceCategoryContestants(category, contestants);

    res.json({
      message: `Uploaded ${result.insertedCount} student(s) for ${category.name}`,
      importedCount: result.insertedCount,
      skippedCount: result.skippedCount
    });
  } catch (error) {
    res.status(500).json({ message: "Could not upload class list" });
  }
});

app.post("/admin/categories/:id/contestants/apply-preset", requireAdmin, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    const sourceCategoryId = (req.body.sourceCategoryId || "").trim();

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    if (!sourceCategoryId) {
      return res.status(400).json({ message: "Select a preset class list first" });
    }

    if (sourceCategoryId === category._id.toString()) {
      return res.status(400).json({ message: "Choose a different category as the preset source" });
    }

    const sourceCategory = await Category.findById(sourceCategoryId).lean();

    if (!sourceCategory) {
      return res.status(404).json({ message: "Preset source category not found" });
    }

    const contestants = await getCategoryContestants(sourceCategoryId);

    if (!contestants.length) {
      return res.status(400).json({ message: "The selected preset does not have an uploaded class list" });
    }

    const result = await replaceCategoryContestants(category, contestants);

    res.json({
      message: `Applied ${sourceCategory.name} as the class list preset for ${category.name}`,
      importedCount: result.insertedCount,
      skippedCount: result.skippedCount
    });
  } catch (error) {
    res.status(500).json({ message: "Could not apply class list preset" });
  }
});

app.delete("/admin/nominees/:id", requireAdmin, async (req, res) => {
  try {
    const nominee = await Nominee.findById(req.params.id);

    if (!nominee) {
      return res.status(404).json({ message: "Student not found in class list" });
    }

    await Vote.deleteMany({ nomineeId: nominee._id.toString() });
    await Nominee.findByIdAndDelete(req.params.id);

    await Category.updateOne(
      { _id: nominee.categoryId },
      {
        $pull: { activeCandidateIds: nominee._id.toString() },
        $set: {
          winnerAnnounced: false,
          announcedAt: null,
          announcedWinners: [],
          closedAt: null,
          isRunoff: false
        }
      }
    );

    res.json({ message: "Student removed from class list" });
  } catch (error) {
    res.status(500).json({ message: "Could not delete class list student" });
  }
});

app.post("/admin/reset-votes", requireAdmin, async (req, res) => {
  try {
    await Vote.deleteMany({});
    await Category.updateMany(
      {},
      {
        $set: {
          isActive: false,
          isRunoff: false,
          currentRoundNumber: 1,
          activeCandidateIds: [],
          closedAt: null,
          winnerAnnounced: false,
          announcedAt: null,
          announcedWinners: []
        }
      }
    );

    res.json({ message: "All votes and round announcements have been reset" });
  } catch (error) {
    res.status(500).json({ message: "Could not reset votes" });
  }
});

app.get("/admin/results", requireAdmin, async (req, res) => {
  try {
    const results = await buildCategoryResults();
    res.json(results);
  } catch (error) {
    res.status(500).json({ message: "Error fetching results" });
  }
});

app.get("/results-data", requireAdmin, async (req, res) => {
  try {
    const results = await buildCategoryResults();
    res.json(results);
  } catch (error) {
    res.status(500).json({ message: "Error fetching protected results" });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/setup", async (req, res) => {
  try {
    await Student.deleteMany({});
    await Category.deleteMany({});
    await Nominee.deleteMany({});
    await Vote.deleteMany({});
    await Admin.deleteMany({});

    await Admin.create({
      username: DEFAULT_ADMIN_USERNAME,
      password: DEFAULT_ADMIN_PASSWORD
    });

    await Student.create([
      { enrollmentNumber: "101", name: "Sahad" },
      { enrollmentNumber: "102", name: "Amina" },
      { enrollmentNumber: "103", name: "Nihal" }
    ]);

    const cat1 = await Category.create({
      name: "Mr Farewell",
      studentListLabel: "MBA 2nd Year",
      isActive: true,
      currentRoundNumber: 1
    });
    const cat2 = await Category.create({
      name: "Best Performer",
      studentListLabel: "BBA 3rd Year"
    });

    const cat1Contestants = await Nominee.insertMany([
      { name: "Ayaan", enrollmentNumber: "MBA201", categoryId: cat1._id.toString() },
      { name: "Rahim", enrollmentNumber: "MBA202", categoryId: cat1._id.toString() }
    ]);

    await Nominee.insertMany([
      { name: "Zaid", enrollmentNumber: "BBA301", categoryId: cat2._id.toString() },
      { name: "Faizan", enrollmentNumber: "BBA302", categoryId: cat2._id.toString() }
    ]);

    cat1.activeCandidateIds = cat1Contestants.map(contestant => contestant._id.toString());
    await cat1.save();

    res.send("Sample data inserted successfully");
  } catch (error) {
    console.log("SETUP ERROR:", error);
    res.send("Error setting up data");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
