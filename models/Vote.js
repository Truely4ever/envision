const mongoose = require("mongoose");

const voteSchema = new mongoose.Schema({
  enrollmentNumber: String,
  categoryId: String,
  nomineeId: String,
  roundNumber: { type: Number, default: 1 }
});

module.exports = mongoose.model("Vote", voteSchema);
