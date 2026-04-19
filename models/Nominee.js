const mongoose = require("mongoose");

const nomineeSchema = new mongoose.Schema({
  name: String,
  image: String,
  details: String,
  categoryId: String,
  votes: { type: Number, default: 0 }
});

module.exports = mongoose.model("Nominee", nomineeSchema);
