const mongoose = require("mongoose");

const voteSchema = new mongoose.Schema({
  enrollmentNumber: String,
  categoryId: String,
  nomineeId: String
});

module.exports = mongoose.model("Vote", voteSchema);