require('dotenv').config();
const mongoose = require('mongoose');
const AttendanceRecord = require('./models/AttendanceRecord');
const HistoricalAttendanceRecord = require('./models/HistoricalAttendanceRecord');
const Event = require('./models/Event');

async function migrateAttendance() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected');

    // Migrate AttendanceRecord
    const attendanceRecords = await AttendanceRecord.find();
    for (const record of attendanceRecords) {
      const event = await Event.findOne({ name: record.event_name }).collation({ locale: 'ru', strength: 2 });
      if (event) {
        record.event_id = event._id;
        await record.save();
        console.log(`Updated AttendanceRecord ${record._id} with event_id ${event._id}`);
      } else {
        console.warn(`Event not found for event_name: ${record.event_name}`);
      }
    }

    // Migrate HistoricalAttendanceRecord
    const historicalRecords = await HistoricalAttendanceRecord.find();
    for (const record of historicalRecords) {
      const event = await Event.findOne({ name: record.event_name }).collation({ locale: 'ru', strength: 2 });
      if (event) {
        record.event_id = event._id;
        await record.save();
        console.log(`Updated HistoricalAttendanceRecord ${record._id} with event_id ${event._id}`);
      } else {
        console.warn(`Event not found for event_name: ${record.event_name}`);
      }
    }

    console.log('Migration completed');
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
}

migrateAttendance();