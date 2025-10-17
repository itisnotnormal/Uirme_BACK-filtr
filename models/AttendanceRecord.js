const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  event_name: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  scanned_by: { type: String, required: true },
  school_id: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  studentName: { type: String },
});

// Unique index including school_id to prevent cross-school duplicates
attendanceSchema.index({ student_id: 1, event_name: 1, school_id: 1 }, { unique: true });

module.exports = mongoose.model('AttendanceRecord', attendanceSchema);