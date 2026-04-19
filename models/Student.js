const mongoose = require("mongoose");

const studentSchema = new mongoose.Schema({
  enrollmentNumber: { type: String, unique: true },
  name: String,
  lastLoginAt: { type: Date, default: null }
});

module.exports = mongoose.model("Student", studentSchema);
