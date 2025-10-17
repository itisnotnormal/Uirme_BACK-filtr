const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, required: true, enum: ['teacher', 'parent', 'student', 'school_admin', 'main_admin', 'district_admin'] },
  school_id: { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
  city: { type: String, default: null },
  name: { type: String },
  children: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
  created_at: { type: Date, default: Date.now },
});

// Add pre-save middleware to enforce `name` requirement for specific roles
UserSchema.pre('save', function (next) {
  if (['teacher', 'parent', 'school_admin', 'district_admin'].includes(this.role) && !this.name) {
    return next(new Error('Name is required for teacher, parent, school_admin, or district_admin roles'));
  }
  if (this.role === 'district_admin' && !this.city) {
    return next(new Error('City is required for district_admin role'));
  }
  next();
});

module.exports = mongoose.model('User', UserSchema);