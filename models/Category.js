const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema({
  name: String,
  studentListLabel: { type: String, default: "" },
  isActive: { type: Boolean, default: false },
  isRunoff: { type: Boolean, default: false },
  currentRoundNumber: { type: Number, default: 1 },
  activeCandidateIds: { type: [String], default: [] },
  closedAt: { type: Date, default: null },
  winnerAnnounced: { type: Boolean, default: false },
  announcedAt: { type: Date, default: null },
  announcedWinners: {
    type: [
      {
        nomineeId: String,
        name: String,
        enrollmentNumber: String,
        votes: Number
      }
    ],
    default: []
  }
});

module.exports = mongoose.model("Category", categorySchema);
