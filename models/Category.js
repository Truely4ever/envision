const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema({
  name: String,
  isActive: { type: Boolean, default: false },
  closedAt: { type: Date, default: null },
  winnerAnnounced: { type: Boolean, default: false },
  announcedAt: { type: Date, default: null },
  announcedWinners: {
    type: [
      {
        nomineeId: String,
        name: String,
        image: String,
        details: String,
        votes: Number
      }
    ],
    default: []
  }
});

module.exports = mongoose.model("Category", categorySchema);
