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
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/farewell";
const DEFAULT_ADMIN_USERNAME = (process.env.DEFAULT_ADMIN_USERNAME || "admin").trim();
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || "admin123";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(cors());
app.use(express.static(__dirname));

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    console.log("MongoDB Connected");
    await ensureDefaultAdmin();
  })
  .catch(error => console.log("MongoDB Error:", error));

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

async function buildCategoryResults() {
  const categories = await Category.find().sort({ name: 1 }).lean();
  const nominees = await Nominee.find().lean();

  return categories.map(category => {
    const categoryNominees = nominees
      .filter(nominee => nominee.categoryId === category._id.toString())
      .sort((a, b) => b.votes - a.votes);

    const highestVotes = categoryNominees.length ? categoryNominees[0].votes : 0;
    const currentLeaders = categoryNominees.filter(
      nominee => nominee.votes === highestVotes && highestVotes > 0
    );

    return {
      ...category,
      totalVotes: categoryNominees.reduce((sum, nominee) => sum + nominee.votes, 0),
      nominees: categoryNominees,
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
    const votedCategoryIds = studentVotes.map(vote => vote.categoryId);
    const hasLoggedIn = Boolean(student.lastLoginAt);
    const hasVotedInActiveRound = activeCategory
      ? votedCategoryIds.includes(activeCategory._id.toString())
      : false;
    const hasVotedInPausedRound = pausedCategory
      ? votedCategoryIds.includes(pausedCategory._id.toString())
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
  await Category.updateMany({}, { $set: { isActive: false } });
  return Category.findByIdAndUpdate(
    categoryId,
    {
      $set: {
        isActive: true,
        closedAt: null
      }
    },
    { new: true }
  );
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
    nominees = await Nominee.find({
      categoryId: activeCategory._id.toString()
    })
      .sort({ name: 1 })
      .lean();
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

    const voteByCategory = votes.reduce((map, vote) => {
      map[vote.categoryId] = vote;
      return map;
    }, {});

    if (activeCategory) {
      const activeVoteRecord = voteByCategory[activeCategory._id.toString()];

      if (activeVoteRecord) {
        activeVote = {
          nomineeId: activeVoteRecord.nomineeId
        };
      }
    }

    if (latestClosedCategory) {
      const pausedVoteRecord = voteByCategory[latestClosedCategory._id.toString()];

      if (pausedVoteRecord) {
        const pausedNominee = await Nominee.findById(pausedVoteRecord.nomineeId).lean();

        pausedVote = {
          nomineeId: pausedVoteRecord.nomineeId,
          nomineeName: pausedNominee?.name || "Selected nominee",
          image: pausedNominee?.image || "",
          details: pausedNominee?.details || ""
        };
      }
    }
  }

  return {
    activeCategory: activeCategory
      ? {
          _id: activeCategory._id,
          name: activeCategory.name
        }
      : null,
    nominees,
    activeVote,
    pausedCategory: !activeCategory && latestClosedCategory
      ? {
          _id: latestClosedCategory._id,
          name: latestClosedCategory.name,
          closedAt: latestClosedCategory.closedAt,
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
        name: activeCategory.name
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

    const nominees = await Nominee.find({
      categoryId: activeCategory._id.toString()
    }).sort({ name: 1 });

    res.json({
      activeCategory: {
        _id: activeCategory._id,
        name: activeCategory.name
      },
      nominees
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching active round nominees" });
  }
});

app.get("/categories", async (req, res) => {
  try {
    const categories = await Category.find().sort({ name: 1 });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: "Error fetching categories" });
  }
});

app.get("/nominees/:categoryId", async (req, res) => {
  try {
    const nominees = await Nominee.find({
      categoryId: req.params.categoryId
    }).sort({ name: 1 });

    res.json(nominees);
  } catch (error) {
    res.status(500).json({ message: "Error fetching nominees" });
  }
});

app.post("/vote", async (req, res) => {
  try {
    const enrollmentNumber = (req.body.enrollmentNumber || "").trim();
    const { categoryId, nomineeId } = req.body;

    const student = await Student.findOne({ enrollmentNumber });
    if (!student) {
      return res.status(400).json({ message: "Student not allowed to vote" });
    }

    const category = await Category.findById(categoryId);
    if (!category || !category.isActive) {
      return res.status(400).json({ message: "This round is not active right now" });
    }

    const nominee = await Nominee.findById(nomineeId);
    if (!nominee || nominee.categoryId !== category._id.toString()) {
      return res.status(400).json({ message: "Selected nominee is not valid for this round" });
    }

    const existingVote = await Vote.findOne({
      enrollmentNumber: student.enrollmentNumber,
      categoryId
    });

    if (existingVote) {
      return res.status(400).json({ message: "Already voted in this category" });
    }

    await Vote.create({
      enrollmentNumber: student.enrollmentNumber,
      categoryId,
      nomineeId
    });

    nominee.votes += 1;
    await nominee.save();

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
    let students = Array.isArray(req.body.students) ? req.body.students : [];

    if (!students.length && req.body.fileContentBase64) {
      const fileName = (req.body.fileName || "").toLowerCase();
      const fileBuffer = Buffer.from(req.body.fileContentBase64, "base64");

      if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
        const workbook = XLSX.read(fileBuffer, { type: "buffer" });
        const firstSheetName = workbook.SheetNames[0];
        const firstSheet = workbook.Sheets[firstSheetName];
        students = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
      } else {
        const workbook = XLSX.read(fileBuffer, { type: "buffer" });
        const firstSheetName = workbook.SheetNames[0];
        const firstSheet = workbook.Sheets[firstSheetName];
        students = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
      }
    }

    if (!students.length) {
      return res.status(400).json({ message: "No students found in uploaded list" });
    }

    const existingEnrollmentNumbers = new Set(
      (await Student.find({}, { enrollmentNumber: 1 }).lean()).map(student => student.enrollmentNumber)
    );

    const uniquePayload = [];
    const seen = new Set();

    students.forEach(student => {
      const normalizedKeys = Object.keys(student).reduce((keys, key) => {
        keys[key.toLowerCase().replace(/\s+/g, "")] = student[key];
        return keys;
      }, {});

      const name = String(
        normalizedKeys.name || normalizedKeys.studentname || ""
      ).trim();

      const enrollmentNumber = String(
        normalizedKeys.enrollmentnumber ||
        normalizedKeys.enrollment ||
        normalizedKeys.admissionnumber ||
        ""
      ).trim();

      if (!name || !enrollmentNumber) {
        return;
      }

      if (existingEnrollmentNumbers.has(enrollmentNumber) || seen.has(enrollmentNumber)) {
        return;
      }

      seen.add(enrollmentNumber);
      uniquePayload.push({ name, enrollmentNumber });
    });

    if (uniquePayload.length) {
      await Student.insertMany(uniquePayload);
    }

    res.json({
      message: `Imported ${uniquePayload.length} student(s)`,
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

    const votes = await Vote.find({
      enrollmentNumber: student.enrollmentNumber
    }).lean();

    const voteCountsByNominee = votes.reduce((counts, vote) => {
      counts[vote.nomineeId] = (counts[vote.nomineeId] || 0) + 1;
      return counts;
    }, {});

    await Promise.all(
      Object.entries(voteCountsByNominee).map(([nomineeId, count]) =>
        Nominee.findByIdAndUpdate(nomineeId, {
          $inc: { votes: -count }
        })
      )
    );

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

    if (!name) {
      return res.status(400).json({ message: "Category name is required" });
    }

    const existingCategory = await Category.findOne({ name });
    if (existingCategory) {
      return res.status(400).json({ message: "Category already exists" });
    }

    const category = await Category.create({
      name,
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
      { $set: { name } },
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

    const nominees = await Nominee.find({
      categoryId: category._id.toString()
    }).lean();

    const nomineeIds = nominees.map(nominee => nominee._id.toString());

    await Vote.deleteMany({
      $or: [
        { categoryId: category._id.toString() },
        { nomineeId: { $in: nomineeIds } }
      ]
    });

    await Nominee.deleteMany({
      categoryId: category._id.toString()
    });

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
    res.status(500).json({ message: "Could not activate round" });
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

    const nominees = await Nominee.find({
      categoryId: category._id.toString()
    }).sort({ votes: -1, name: 1 });

    if (!nominees.length || nominees[0].votes <= 0) {
      return res.status(400).json({ message: "No winner can be announced yet" });
    }

    const topVotes = nominees[0].votes;
    const winners = nominees
      .filter(nominee => nominee.votes === topVotes)
      .map(nominee => ({
        nomineeId: nominee._id.toString(),
        name: nominee.name,
        image: nominee.image || "",
        details: nominee.details || "",
        votes: nominee.votes
      }));

    category.winnerAnnounced = true;
    category.announcedAt = new Date();
    category.announcedWinners = winners;
    category.isActive = false;
    category.closedAt = new Date();
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
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  } catch (error) {
    res.status(500).json({ message: "Error fetching nominees" });
  }
});

app.post("/admin/nominees", requireAdmin, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const image = (req.body.image || "").trim();
    const details = (req.body.details || "").trim();
    const { categoryId } = req.body;

    if (!name || !categoryId) {
      return res.status(400).json({
        message: "Nominee name and category are required"
      });
    }

    const category = await Category.findById(categoryId);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    const nominee = await Nominee.create({
      name,
      image,
      details,
      categoryId
    });

    res.status(201).json(nominee);
  } catch (error) {
    res.status(500).json({ message: "Could not create nominee" });
  }
});

app.delete("/admin/nominees/:id", requireAdmin, async (req, res) => {
  try {
    const nominee = await Nominee.findById(req.params.id);

    if (!nominee) {
      return res.status(404).json({ message: "Nominee not found" });
    }

    const categoryId = nominee.categoryId;
    await Vote.deleteMany({ nomineeId: nominee._id.toString() });
    await Nominee.findByIdAndDelete(req.params.id);

    await Category.updateMany(
      { _id: categoryId },
      {
        $set: {
          winnerAnnounced: false,
          announcedAt: null,
          announcedWinners: [],
          closedAt: null
        }
      }
    );

    res.json({ message: "Nominee deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Could not delete nominee" });
  }
});

app.post("/admin/reset-votes", requireAdmin, async (req, res) => {
  try {
    await Vote.deleteMany({});
    await Nominee.updateMany({}, { $set: { votes: 0 } });
    await Category.updateMany(
      {},
      {
        $set: {
          isActive: false,
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

    const cat1 = await Category.create({ name: "Best Student", isActive: true });
    const cat2 = await Category.create({ name: "Best Performer", isActive: false });

    await Nominee.create([
      {
        name: "Ayaan",
        image: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=600&q=80",
        details: "Strong academic record and consistent student leadership.",
        categoryId: cat1._id.toString()
      },
      {
        name: "Rahim",
        image: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=600&q=80",
        details: "Known for mentoring classmates and campus participation.",
        categoryId: cat1._id.toString()
      },
      {
        name: "Zaid",
        image: "https://images.unsplash.com/photo-1507591064344-4c6ce005b128?auto=format&fit=crop&w=600&q=80",
        details: "Stage performer with strong event energy and crowd presence.",
        categoryId: cat2._id.toString()
      },
      {
        name: "Faizan",
        image: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=600&q=80",
        details: "Recognized for creative performances and team coordination.",
        categoryId: cat2._id.toString()
      }
    ]);

    res.send("Sample data inserted successfully");
  } catch (error) {
    console.log("SETUP ERROR:", error);
    res.send("Error setting up data");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
