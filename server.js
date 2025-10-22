require('dotenv').config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const Student = require("./models/Student");
const Event = require("./models/Event");
const AttendanceRecord = require("./models/AttendanceRecord");
const HistoricalAttendanceRecord = require("./models/HistoricalAttendanceRecord");
const User = require("./models/User");
const School = require("./models/School");

const app = express();
app.use(express.json());
app.use(cors({ origin: "http://localhost:3000" }));
app.use(morgan("dev"));

console.log("MongoDB URI:", process.env.MONGO_URI);
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Auth middleware
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
};

const roleMiddleware = (roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: "Access denied" });
  }
  next();
};

// Helper to get school IDs for district admin
async function getDistrictSchoolIds(user) {
  if (user.role === "district_admin") {
    const schools = await School.find({ city: user.city });
    return schools.map(s => s._id.toString()); // Return as strings for easy comparison
  }
  return null;
}

// Login route
app.post("/auth/login", async (req, res) => {
  const { email, password, role } = req.body;
  try {
    const user = await User.findOne({ email, role }).populate("school_id");
    if (!user) return res.status(400).json({ error: "Invalid credentials" });

    let isMatch;
    isMatch = password === user.password;
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { userId: user._id, role: user.role, school_id: user.school_id?._id, city: user.city },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    res.json({ token, role: user.role, school_id: user.school_id?._id, city: user.city });
  } catch (err) {
    console.error("Login error:", err.message, err.stack);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Register route for users
app.post(
  "/auth/register",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin"]),
  async (req, res) => {
    const { email, password, role, school_id, name, city } = req.body;
    try {
      if (!email || !password) return res.status(400).json({ error: "Email and password required" });
      if (role === "district_admin" && !city) return res.status(400).json({ error: "City required for district_admin" });

      let existingUser = await User.findOne({ email });
      if (existingUser) return res.status(400).json({ error: "User already exists" });

      let hashedPassword = password;

      const user = new User({
        email,
        password: hashedPassword,
        role,
        school_id: school_id || null,
        name,
        city: role === "district_admin" ? city : undefined,
      });
      await user.save();
      res.json({ message: "User registered" });
    } catch (err) {
      console.error("Register error:", err.message, err.stack);
      res.status(500).json({ error: "Server error", details: err.message });
    }
  }
);

// Seed demo user and school
(async () => {
  const demoEmail = "admin@education.gov";
  const existingUser = await User.findOne({ email: demoEmail });
  if (!existingUser) {
    const hashedPassword = "admin123";
    const demoUser = new User({ email: demoEmail, password: hashedPassword, role: "main_admin" });
    await demoUser.save();
    console.log("Demo main_admin user created");
  }
  const defaultSchool = await School.findOne({ name: "Default School" });
  if (!defaultSchool) {
    const school = new School({ name: "Default School", city: "Default City", created_at: new Date() });
    await school.save();
    console.log("Default school created:", school);
  }
  const demoDistrictEmail = "district@education.gov";
  const existingDistrict = await User.findOne({ email: demoDistrictEmail });
  if (!existingDistrict) {
    const hashedPassword = "district123";
    const demoDistrict = new User({ email: demoDistrictEmail, password: hashedPassword, role: "district_admin", city: "Demo City", name: "Demo District Admin" });
    await demoDistrict.save();
    console.log("Demo district_admin user created");
  }
})();

// Add child to parent
app.put(
  "/users/:id/add-child",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin"]),
  async (req, res) => {
    try {
      const { student_id } = req.body;
      const user = await User.findById(req.params.id);
      if (!user || user.role !== "parent") return res.status(400).json({ error: "Not a parent" });
      if (req.user.role === "school_admin" && user.school_id.toString() !== req.user.school_id)
        return res.status(403).json({ error: "Access denied" });
      if (req.user.role === "district_admin") {
        const school = await School.findById(user.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      const student = await Student.findById(student_id);
      if (!student) return res.status(404).json({ error: "Student not found" });
      if (req.user.role === "school_admin" && student.school_id.toString() !== req.user.school_id)
        return res.status(403).json({ error: "Access denied" });
      if (req.user.role === "district_admin") {
        const school = await School.findById(student.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      if (!user.children.includes(student_id)) {
        user.children.push(student_id);
        await user.save();
      }
      res.json(user);
    } catch (err) {
      console.error("Error adding child:", err.message, err.stack);
      res.status(500).json({ error: "Error adding child", details: err.message });
    }
  }
);

// Remove child from parent (new endpoint)
app.put(
  "/users/:id/remove-child",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin"]),
  async (req, res) => {
    try {
      const { student_id } = req.body;
      const user = await User.findById(req.params.id);
      if (!user || user.role !== "parent") return res.status(400).json({ error: "Not a parent" });
      if (req.user.role === "school_admin" && user.school_id.toString() !== req.user.school_id)
        return res.status(403).json({ error: "Access denied" });
      if (req.user.role === "district_admin") {
        const school = await School.findById(user.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      const student = await Student.findById(student_id);
      if (!student) return res.status(404).json({ error: "Student not found" });
      if (req.user.role === "school_admin" && student.school_id.toString() !== req.user.school_id)
        return res.status(403).json({ error: "Access denied" });
      if (req.user.role === "district_admin") {
        const school = await School.findById(student.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      user.children = user.children.filter((child) => child.toString() !== student_id);
      await user.save();
      res.json(user);
    } catch (err) {
      console.error("Error removing child:", err.message, err.stack);
      res.status(500).json({ error: "Error removing child", details: err.message });
    }
  }
);

// Get my children for parent
app.get("/my-children", authMiddleware, roleMiddleware(["parent"]), async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).populate("children");
    res.json(user.children);
  } catch (err) {
    console.error("Error fetching children:", err.message, err.stack);
    res.status(500).json({ error: "Error fetching children", details: err.message });
  }
});

// Get my student data for student role
app.get("/my-student", authMiddleware, roleMiddleware(["student"]), async (req, res) => {
  try {
    const student = await Student.findOne({ user_id: req.user.userId }).populate("school_id");
    if (!student) return res.status(404).json({ error: "Student data not found" });
    res.json(student);
  } catch (err) {
    console.error("Error fetching my student:", err.message, err.stack);
    res.status(500).json({ error: "Error fetching my student", details: err.message });
  }
});

// Schools routes
app.get("/schools", authMiddleware, roleMiddleware(["main_admin", "school_admin", "district_admin"]), async (req, res) => {
  try {
    let query = {};
    if (req.user.role === "school_admin") {
      query = { _id: req.user.school_id };
    } else if (req.user.role === "district_admin") {
      const schoolIds = await getDistrictSchoolIds(req.user);
      if (schoolIds.length === 0) {
        console.warn(`No schools found for district_admin: ${req.user.userId}, city: ${req.user.city}`);
        return res.json([]);
      }
      query = { _id: { $in: schoolIds } };
      // Ignore req.query.city for district_admin to prevent conflicts
      if (req.query.city && req.query.city !== req.user.city && req.query.city !== "all") {
        console.warn(`District admin attempted to filter by unauthorized city: ${req.query.city}`);
        return res.status(403).json({ error: "Access denied: Cannot filter by different city" });
      }
    } else if (req.query.city && req.query.city !== "all") {
      query.city = req.query.city;
    }
    if (req.query.search) {
      query.name = { $regex: req.query.search.trim(), $options: 'i' };
    }
    console.log(`Fetching schools with query: ${JSON.stringify(query)}`);
    const schools = await School.find(query).sort({ created_at: -1 }).lean();
    console.log(`Found ${schools.length} schools for user: ${req.user.userId}, role: ${req.user.role}`);
    res.json(schools);
  } catch (err) {
    console.error(`Error fetching schools for user: ${req.user.userId}, error: ${err.message}`, err.stack);
    res.status(500).json({ error: "Error fetching schools", details: err.message });
  }
});

app.post("/schools", authMiddleware, roleMiddleware(["main_admin"]), async (req, res) => {
  try {
    const { name, city } = req.body;
    if (!name || !city) return res.status(400).json({ error: "School name and city required" });
    const school = new School({ name, city, created_at: new Date() });
    await school.save();
    res.json(school);
  } catch (err) {
    console.error("Error adding school:", err.message, err.stack);
    res.status(500).json({ error: "Error adding school", details: err.message });
  }
});

app.put("/schools/:id", authMiddleware, roleMiddleware(["main_admin"]), async (req, res) => {
  try {
    const { name, city } = req.body;
    if (!name || !city) return res.status(400).json({ error: "School name and city required" });
    const school = await School.findByIdAndUpdate(
      req.params.id,
      { name, city, updated_at: new Date() },
      { new: true }
    );
    if (!school) return res.status(404).json({ error: "School not found" });
    res.json(school);
  } catch (err) {
    console.error("Error updating school:", err.message, err.stack);
    res.status(500).json({ error: "Error updating school", details: err.message });
  }
});

app.delete("/schools/:id", authMiddleware, roleMiddleware(["main_admin"]), async (req, res) => {
  try {
    const school = await School.findByIdAndDelete(req.params.id);
    if (!school) return res.status(404).json({ error: "School not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting school:", err.message, err.stack);
    res.status(500).json({ error: "Error deleting school", details: err.message });
  }
});

app.get(
  "/schools/:id",
  authMiddleware,
  roleMiddleware(["main_admin", "school_admin", "teacher", "parent", "district_admin"]),
  async (req, res) => {
    try {
      const schoolId = req.params.id;
      const school = await School.findById(schoolId);
      if (!school) return res.status(404).json({ error: "School not found" });
      if (req.user.role === "district_admin" && school.city !== req.user.city) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (
        req.user.role === "school_admin" ||
        req.user.role === "teacher" ||
        req.user.role === "parent"
      ) {
        if (req.user.school_id.toString() !== schoolId) {
          return res.status(403).json({ error: "Access denied" });
        }
      }
      res.json(school);
    } catch (err) {
      console.error("Error fetching school:", err.message, err.stack);
      res.status(500).json({ error: "Error fetching school", details: err.message });
    }
  }
);

app.put("/schools/:id/assign", authMiddleware, roleMiddleware(["main_admin"]), async (req, res) => {
  const { district_admin_id } = req.body;
  try {
    const admin = await User.findById(district_admin_id);
    if (!admin || admin.role !== "district_admin") {
      return res.status(400).json({ error: "Invalid district admin" });
    }
    const school = await School.findByIdAndUpdate(req.params.id, { city: admin.city }, { new: true });
    if (!school) {
      return res.status(404).json({ error: "School not found" });
    }
    res.json(school);
  } catch (err) {
    console.error("Error assigning school:", err.message, err.stack);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Cities route for unique cities
app.get("/cities", authMiddleware, roleMiddleware(["main_admin"]), async (req, res) => {
  try {
    const cities = await School.distinct("city");
    res.json(cities.filter(c => c).sort());
  } catch (err) {
    console.error("Error fetching cities:", err.message, err.stack);
    res.status(500).json({ error: "Error fetching cities", details: err.message });
  }
});

// Users routes
app.get("/users", authMiddleware, async (req, res) => {
  try {
    let query = {};
    if (req.user.role === "school_admin") {
      query = { school_id: req.user.school_id };
    } else if (req.user.role === "district_admin") {
      const schoolIds = await getDistrictSchoolIds(req.user);
      if (req.query.school_id) {
        const specificSchool = req.query.school_id.toString();
        if (schoolIds.includes(specificSchool)) {
          query = { school_id: specificSchool };
        } else {
          return res.status(403).json({ error: "Access denied: School not in your district" });
        }
      } else {
        query = { school_id: { $in: schoolIds } };
      }
    } else if (req.query.school_id) {
      query = { school_id: req.query.school_id };
    }
    if (req.user.role === "district_admin" && req.query.role === "district_admin") {
      return res.status(403).json({ error: "Access denied" });
    }
    if (req.query.role) {
      query.role = req.query.role;
    }
    const users = await User.find(query)
      .populate("school_id", "name")
      .populate("children", "name group course")
      .sort({ created_at: -1 });
    res.json(users);
  } catch (err) {
    console.error("Error fetching users:", err.message, err.stack);
    res.status(500).json({ error: "Error fetching users", details: err.message });
  }
});

app.delete(
  "/users/:id",
  authMiddleware,
  roleMiddleware(["main_admin", "school_admin"]),
  async (req, res) => {
    try {
      const userToDelete = await User.findById(req.params.id);
      if (!userToDelete) return res.status(404).json({ error: "User not found" });
      if (req.user.role === "school_admin" && userToDelete.school_id?.toString() !== req.user.school_id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "district_admin") {
        if (userToDelete.role === "district_admin") return res.status(403).json({ error: "Access denied" });
        const school = await School.findById(userToDelete.school_id);
        if (school?.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      const user = await User.findByIdAndDelete(req.params.id);
      if (!user) return res.status(404).json({ error: "User not found" });
      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting user:", err.message, err.stack);
      res.status(500).json({ error: "Error deleting user", details: err.message });
    }
  }
);

// Students routes
app.get("/students", authMiddleware, async (req, res) => {
  try {
    let query = {};
    if (req.user.role === "school_admin") {
      query = { school_id: req.user.school_id };
    } else if (req.user.role === "district_admin") {
      const schoolIds = await getDistrictSchoolIds(req.user);
      if (req.query.school_id) {
        const specificSchool = req.query.school_id.toString();
        if (schoolIds.includes(specificSchool)) {
          query = { school_id: specificSchool };
        } else {
          return res.status(403).json({ error: "Access denied: School not in your district" });
        }
      } else {
        query = { school_id: { $in: schoolIds } };
      }
    } else if (req.query.school_id) {
      query = { school_id: req.query.school_id };
    }
    const students = await Student.find(query)
      .populate("user_id", "email password")
      .sort({ created_at: -1 });
    res.json(students);
  } catch (err) {
    console.error("Error fetching students:", err.message, err.stack);
    res.status(500).json({ error: "Error fetching students", details: err.message });
  }
});

app.get("/students/:id", authMiddleware, async (req, res) => {
  try {
    const student = await Student.findById(req.params.id).populate("user_id", "email password");
    if (!student) return res.status(404).json({ error: "Student not found" });
    if (req.user.role === "school_admin" && student.school_id.toString() !== req.user.school_id) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (req.user.role === "district_admin") {
      const school = await School.findById(student.school_id);
      if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
    }
    res.json(student);
  } catch (err) {
    console.error("Error fetching student:", err.message, err.stack);
    res.status(500).json({ error: "Error fetching student", details: err.message });
  }
});

app.get(
  "/students/qr/:qrCode",
  authMiddleware,
  roleMiddleware(["teacher", "school_admin", "main_admin", "district_admin"]),
  async (req, res) => {
    try {
      let query = { qr_code: req.params.qrCode };
      if (req.user.role === "school_admin") {
        query = { ...query, school_id: req.user.school_id };
      } else if (req.user.role === "district_admin") {
        const schools = await School.find({ city: req.user.city });
        const schoolIds = schools.map(s => s._id);
        query = { ...query, school_id: { $in: schoolIds } };
      }
      const student = await Student.findOne(query);
      if (!student) return res.status(404).json({ error: "Student not found" });
      res.json(student);
    } catch (err) {
      console.error("Error fetching student by QR:", err.message, err.stack);
      res.status(500).json({ error: "Error fetching student by QR", details: err.message });
    }
  }
);

app.post(
  "/students",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin"]),
  async (req, res) => {
    const { name, group, specialty, email, password, school_id } = req.body;
    try {
      if (req.user.role === "school_admin" && school_id !== req.user.school_id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "district_admin") {
        const school = await School.findById(school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }

      const qr_code = uuidv4();

      let user = new User({
        email,
        password,
        role: "student",
        school_id,
      });
      await user.save();

      const student = new Student({
        name,
        group,
        specialty,
        qr_code,
        school_id: school_id || req.user.school_id,
        user_id: user._id,
      });
      await student.save();
      res.json(student);
    } catch (err) {
      console.error("Error adding student:", err.message, err.stack);
      res.status(500).json({ error: "Server error", details: err.message });
    }
  }
);

app.put(
  "/students/:id",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin"]),
  async (req, res) => {
    try {
      const student = await Student.findById(req.params.id);
      if (!student) return res.status(404).json({ error: "Student not found" });
      if (req.user.role === "school_admin" && student.school_id.toString() !== req.user.school_id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "district_admin") {
        const school = await School.findById(student.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }

      // Validate school_id if provided
      if (req.body.school_id && !mongoose.isValidObjectId(req.body.school_id)) {
        return res.status(400).json({ error: "Invalid school_id" });
      }
      if (req.body.school_id) {
        const newSchool = await School.findById(req.body.school_id);
        if (!newSchool) return res.status(400).json({ error: "School not found" });
        if (req.user.role === "district_admin" && newSchool.city !== req.user.city) {
          return res.status(403).json({ error: "Access denied" });
        }
      }

      // Extract password and other student updates
      const { password, email, ...studentUpdates } = req.body;

      // If email is provided, check for uniqueness in User collection
      if (email) {
        const existingUser = await User.findOne({ email });
        if (existingUser && existingUser._id.toString() !== student.user_id.toString()) {
          return res.status(400).json({ error: "Email already exists" });
        }
      }

      // Update associated user if email or password is provided
      if (email || password) {
        const userUpdates = {};
        if (email) userUpdates.email = email;
        if (password) {
          userUpdates.password = password; // No hash for student
        }
        await User.findByIdAndUpdate(student.user_id, userUpdates);
      }

      // Update student data
      const updatedStudent = await Student.findByIdAndUpdate(req.params.id, studentUpdates, { new: true });
      if (!updatedStudent) return res.status(404).json({ error: "Student not found" });

      res.json(updatedStudent);
    } catch (err) {
      console.error("Error updating student:", err.message, err.stack);
      res.status(500).json({ error: "Error updating student", details: err.message });
    }
  }
);

app.delete(
  "/students/:id",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin"]),
  async (req, res) => {
    try {
      const student = await Student.findById(req.params.id);
      if (!student) return res.status(404).json({ error: "Student not found" });
      if (req.user.role === "school_admin" && student.school_id.toString() !== req.user.school_id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "district_admin") {
        const school = await School.findById(student.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      await Student.findByIdAndDelete(req.params.id);
      await User.findOneAndDelete({ _id: student.user_id });
      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting student:", err.message, err.stack);
      res.status(500).json({ error: "Error deleting student", details: err.message });
    }
  }
);

// Events routes
app.get("/events", authMiddleware, async (req, res) => {
  try {
    let query = {};
    if (req.user.role === "school_admin" || req.user.role === "teacher") {
      query = { school_id: req.user.school_id };
      if (req.user.role === "teacher") {
        query = { ...query, teacher_id: req.user.userId };
      }
    } else if (req.user.role === "district_admin") {
      const schoolIds = await getDistrictSchoolIds(req.user);
      if (req.query.school_id) {
        const specificSchool = req.query.school_id.toString();
        if (schoolIds.includes(specificSchool)) {
          query = { school_id: specificSchool };
        } else {
          return res.status(403).json({ error: "Access denied: School not in your district" });
        }
      } else {
        query = { school_id: { $in: schoolIds } };
      }
    } else if (req.query.school_id) {
      query = { school_id: req.query.school_id };
    }
    const events = await Event.find(query).sort({ created_at: -1 });
    res.json(events);
  } catch (err) {
    console.error("Error fetching events:", err.message, err.stack);
    res.status(500).json({ error: "Error fetching events", details: err.message });
  }
});

app.get("/events/active", authMiddleware, async (req, res) => {
  try {
    let query = { is_active: true };
    if (req.user.role === "school_admin" || req.user.role === "teacher") {
      query = { ...query, school_id: req.user.school_id };
      if (req.user.role === "teacher") {
        query = { ...query, teacher_id: req.user.userId };
      }
    } else if (req.user.role === "district_admin") {
      const schoolIds = await getDistrictSchoolIds(req.user);
      if (req.query.school_id) {
        const specificSchool = req.query.school_id.toString();
        if (schoolIds.includes(specificSchool)) {
          query = { ...query, school_id: specificSchool };
        } else {
          return res.status(403).json({ error: "Access denied: School not in your district" });
        }
      } else {
        query = { ...query, school_id: { $in: schoolIds } };
      }
    } else if (req.query.school_id) {
      query = { ...query, school_id: req.query.school_id };
    }
    const events = await Event.find(query).sort({ created_at: -1 });
    res.json(events);
  } catch (err) {
    console.error("Error fetching active events:", err.message, err.stack);
    res.status(500).json({ error: "Error fetching active events", details: err.message });
  }
});

app.post(
  "/events",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin"]),
  async (req, res) => {
    try {
      const { name, schedule, description, is_active, teacher_id, school_id } = req.body;
      if (req.user.role === "school_admin") {
        if (school_id !== req.user.school_id.toString()) return res.status(403).json({ error: "Access denied" });
      } else if (req.user.role === "district_admin") {
        const school = await School.findById(school_id);
        if (!school || school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      if (!school_id) return res.status(400).json({ error: "School ID required" });
      const school = await School.findById(school_id);
      if (!school) return res.status(400).json({ error: "School not found" });
      if (!teacher_id) return res.status(400).json({ error: "Teacher ID required" });
      const teacher = await User.findOne({ _id: teacher_id, role: "teacher", school_id });
      if (!teacher) return res.status(400).json({ error: "Invalid teacher: not found or doesn't belong to the school" });
      const trimmedName = name.trim();
      const event = new Event({
        name: trimmedName,
        schedule,
        description,
        is_active: is_active || false,
        school_id,
        teacher_id,
        created_at: new Date(),
      });
      await event.save();
      res.json(event);
    } catch (err) {
      console.error("Error adding event:", err.message, err.stack);
      res.status(500).json({ error: "Error adding event", details: err.message });
    }
  }
);

app.put(
  "/events/:id",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin"]),
  async (req, res) => {
    try {
      const event = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ error: "Event not found" });
      if (req.user.role === "school_admin" && event.school_id.toString() !== req.user.school_id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "district_admin") {
        const school = await School.findById(event.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      const { name, schedule, description, is_active, teacher_id } = req.body;
      const trimmedName = name.trim();
      let updates = { name: trimmedName, schedule, description, is_active, updated_at: new Date() };
      if (teacher_id) {
        const teacher = await User.findOne({ _id: teacher_id, role: "teacher", school_id: event.school_id });
        if (!teacher) return res.status(400).json({ error: "Invalid teacher: not found or doesn't belong to the school" });
        updates = { ...updates, teacher_id };
      }
      const updatedEvent = await Event.findByIdAndUpdate(req.params.id, updates, { new: true });
      res.json(updatedEvent);
    } catch (err) {
      console.error("Error updating event:", err.message, err.stack);
      res.status(500).json({ error: "Error updating event", details: err.message });
    }
  }
);

app.put(
  "/events/:id/toggle-active",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin", "teacher"]),
  async (req, res) => {
    try {
      const event = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ error: "Event not found" });
      if (req.user.role === "school_admin" && event.school_id.toString() !== req.user.school_id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "district_admin") {
        const school = await School.findById(event.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "teacher" && event.teacher_id.toString() !== req.user.userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      const { is_active } = req.body;
      if (is_active === false) {
        const records = await AttendanceRecord.find({ event_name: event.name, school_id: event.school_id });
        if (records.length > 0) {
          const archived_at = new Date();
          const historicalData = records.map(record => ({
            student_id: record.student_id,
            event_name: record.event_name,
            timestamp: record.timestamp,
            scanned_by: record.scanned_by,
            school_id: record.school_id,
            studentName: record.studentName,
            archived_at: archived_at
          }));
          await HistoricalAttendanceRecord.insertMany(historicalData);
          await AttendanceRecord.deleteMany({ event_name: event.name, school_id: event.school_id });
        }
      }
      event.is_active = is_active;
      event.updated_at = new Date();
      await event.save();
      res.json({ success: true });
    } catch (err) {
      console.error("Error toggling event active status:", err.message, err.stack);
      res.status(500).json({ error: "Error toggling event active status", details: err.message });
    }
  }
);

app.delete(
  "/events/:id",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin"]),
  async (req, res) => {
    try {
      const event = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ error: "Event not found" });
      if (req.user.role === "school_admin" && event.school_id.toString() !== req.user.school_id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "district_admin") {
        const school = await School.findById(event.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      await Event.findByIdAndDelete(req.params.id);
      await AttendanceRecord.deleteMany({ event_name: event.name, school_id: event.school_id });
      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting event:", err.message, err.stack);
      res.status(500).json({ error: "Error deleting event", details: err.message });
    }
  }
);

// Get events by teacher
app.get("/events/teacher/:teacherId", authMiddleware, roleMiddleware(["teacher", "school_admin", "main_admin"]), async (req, res) => {
  try {
    const { teacherId } = req.params;
    if (req.user.role === "teacher" && req.user.userId !== teacherId) {
      return res.status(403).json({ error: "Access denied" });
    }
    let schoolFilter = {};
    if (req.user.role === "school_admin") {
      schoolFilter = { school_id: req.user.school_id };
    } else if (req.user.role === "district_admin") {
      const schoolIds = await getDistrictSchoolIds(req.user);
      schoolFilter = { school_id: { $in: schoolIds } };
    }
    const events = await Event.find({ ...schoolFilter, teacher_id: teacherId }).lean();
    res.json(events);
  } catch (err) {
    console.error("Error fetching events for teacher:", err.message, err.stack);
    res.status(500).json({ error: "Error fetching events", details: err.message });
  }
});

// Attendance routes
app.get("/attendance", authMiddleware, async (req, res) => {
  try {
    let query = {};
    if (req.user.role === "school_admin") {
      query = { school_id: req.user.school_id };
    } else if (req.user.role === "district_admin") {
      const schoolIds = await getDistrictSchoolIds(req.user);
      if (req.query.school_id) {
        const specificSchool = req.query.school_id.toString();
        if (schoolIds.includes(specificSchool)) {
          query = { school_id: specificSchool };
        } else {
          return res.status(403).json({ error: "Access denied: School not in your district" });
        }
      } else {
        query = { school_id: { $in: schoolIds } };
      }
    } else if (req.query.school_id) {
      query = { school_id: req.query.school_id };
    }

    // Add city filter if provided and not "all"
    if (req.query.city && req.query.city !== "all") {
      const schools = await School.find({ city: req.query.city }).select('_id').lean();
      const schoolIds = schools.map(s => s._id.toString());
      if (schoolIds.length === 0) {
        console.warn(`No schools found for city: ${req.query.city}`);
        return res.json([]);
      }
      query.school_id = { $in: schoolIds };
    }

    // Apply period filter
    const period = req.query.period;
    if (period) {
      const now = new Date();
      let startDate;
      if (period === "week") startDate = new Date(now - 7 * 24 * 60 * 60 * 1000);
      else if (period === "month") startDate = new Date(now - 30 * 24 * 60 * 60 * 1000);
      else if (period === "year") startDate = new Date(now - 365 * 24 * 60 * 60 * 1000);
      else startDate = new Date(0);
      query.timestamp = { $gte: startDate };
    }

    console.log(`Fetching attendance with query: ${JSON.stringify(query)}`);

    // Fetch current and historical records
    const currentRecords = await AttendanceRecord.find(query)
      .populate({
        path: "student_id",
        select: "name group specialty school_id",
        options: { strictPopulate: false }
      })
      .lean();
    const historicalRecords = await HistoricalAttendanceRecord.find(query)
      .populate({
        path: "student_id",
        select: "name group specialty school_id",
        options: { strictPopulate: false }
      })
      .lean();

    console.log(`Found ${currentRecords.length} current records, ${historicalRecords.length} historical records`);

    // Combine and filter records
    let allRecords = [...currentRecords, ...historicalRecords];
    allRecords = allRecords.filter(record => record.student_id && record.timestamp); // Ensure student_id and timestamp exist
    allRecords.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    console.log(`Total records after filtering: ${allRecords.length}`);

    // Map records to response format
    const response = allRecords.map((record) => ({
      _id: record._id,
      student_id: record.student_id._id,
      studentName: record.student_id?.name || "Неизвестно",
      group: record.student_id?.group || "",
      specialty: record.student_id?.specialty || "",
      event_name: record.event_name,
      timestamp: record.timestamp,
      scanned_by: record.scanned_by,
      school_id: record.school_id,
      location: record.location,
    }));

    res.json(response);
  } catch (err) {
    console.error(`Error fetching attendance for user: ${req.user.userId}, error: ${err.message}`, err.stack);
    res.status(500).json({ error: "Error fetching attendance", details: err.message });
  }
});

app.get(
  "/attendance/event/:eventName",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin", "teacher", "district_admin"]),
  async (req, res) => {
    try {
      const eventName = req.params.eventName.trim();
      let eventQuery = { name: eventName };
      if (req.user.role !== "main_admin") {
        if (req.user.role === "district_admin") {
          const schoolIds = await getDistrictSchoolIds(req.user);
          eventQuery = { ...eventQuery, school_id: { $in: schoolIds } };
        } else {
          eventQuery = { ...eventQuery, school_id: req.user.school_id };
        }
      } else if (req.query.school_id) {
        eventQuery = { ...eventQuery, school_id: req.query.school_id };
      }
      const event = await Event.findOne(eventQuery).collation({ locale: "ru", strength: 2 });
      if (!event) return res.status(404).json({ error: "Event not found" });

      if (req.user.role === "school_admin" && event.school_id.toString() !== req.user.school_id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "district_admin") {
        const school = await School.findById(event.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "teacher" && event.teacher_id.toString() !== req.user.userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const records = await AttendanceRecord.find({ event_name: eventName, school_id: event.school_id })
        .collation({ locale: "ru", strength: 2 })
        .populate("student_id", "name")
        .sort({ timestamp: -1 });

      const filteredRecords = records
        .filter((record) => record.student_id != null)
        .map((record) => ({
          _id: record._id,
          student_id: record.student_id._id,
          studentName: record.student_id.name || "Unknown Student",
          event_name: record.event_name,
          timestamp: record.timestamp,
          scanned_by: record.scanned_by,
        }));

      res.json(filteredRecords);
    } catch (err) {
      console.error("Error fetching attendance by event:", err.message, err.stack);
      res.status(500).json({ error: "Error fetching attendance by event", details: err.message });
    }
  }
);

app.get(
  "/attendance/student/:studentId",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin", "parent", "student", "district_admin"]),
  async (req, res) => {
    try {
      const studentId = req.params.studentId;
      const student = await Student.findById(studentId);
      if (!student) return res.status(404).json({ error: "Student not found" });
      if (
        req.user.role === "school_admin" ||
        req.user.role === "teacher" ||
        req.user.role === "parent"
      ) {
        if (student.school_id.toString() !== req.user.school_id) {
          return res.status(403).json({ error: "Access denied" });
        }
      }
      if (req.user.role === "district_admin") {
        const school = await School.findById(student.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "parent") {
        const user = await User.findById(req.user.userId);
        if (!user.children.includes(studentId)) {
          return res.status(403).json({ error: "Access denied" });
        }
      }
      const currentRecords = await AttendanceRecord.find({ student_id: studentId }).populate("student_id", "name");
      const historicalRecords = await HistoricalAttendanceRecord.find({ student_id: studentId }).populate("student_id", "name");
      let allRecords = [...currentRecords, ...historicalRecords];
      allRecords.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      res.json(
        allRecords.map((record) => ({
          _id: record._id,
          student_id: record.student_id._id,
          studentName: record.student_id.name,
          event_name: record.event_name,
          timestamp: record.timestamp,
          scanned_by: record.scanned_by,
        }))
      );
    } catch (err) {
      console.error("Error fetching attendance by student:", err.message, err.stack);
      res.status(500).json({
        error: "Error fetching attendance by student",
        details: err.message,
      });
    }
  }
);

app.get(
  "/attendance/check",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin", "teacher", "district_admin"]),
  async (req, res) => {
    try {
      const { studentId, eventName } = req.query;
      if (!studentId || !eventName) {
        return res.status(400).json({ error: "Student ID and event name required" });
      }
      let eventQuery = { name: eventName };
      if (req.user.role !== "main_admin") {
        if (req.user.role === "district_admin") {
          const schools = await School.find({ city: req.user.city });
          const schoolIds = schools.map(s => s._id);
          eventQuery = { ...eventQuery, school_id: { $in: schoolIds } };
        } else {
          eventQuery = { ...eventQuery, school_id: req.user.school_id };
        }
      }
      const event = await Event.findOne(eventQuery);
      if (!event) return res.status(404).json({ error: "Event not found" });
      if (
        req.user.role === "school_admin" ||
        req.user.role === "teacher"
      ) {
        if (event.school_id.toString() !== req.user.school_id) {
          return res.status(403).json({ error: "Access denied" });
        }
      }
      if (req.user.role === "district_admin") {
        const school = await School.findById(event.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      const record = await AttendanceRecord.findOne({ student_id: studentId, event_name: eventName, school_id: event.school_id });
      res.json(!!record);
    } catch (err) {
      console.error("Error checking attendance:", err.message, err.stack);
      res.status(500).json({ error: "Error checking attendance", details: err.message });
    }
  }
);

app.post(
  "/attendance",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin", "teacher"]),
  async (req, res) => {
    try {
      const { student_id, event_name, timestamp, scanned_by } = req.body;
      const trimmedEventName = event_name.trim();
      let eventQuery = { name: trimmedEventName };
      if (req.user.role !== "main_admin") {
        if (req.user.role === "district_admin") {
          const schools = await School.find({ city: req.user.city });
          const schoolIds = schools.map(s => s._id);
          eventQuery = { ...eventQuery, school_id: { $in: schoolIds } };
        } else {
          eventQuery = { ...eventQuery, school_id: req.user.school_id };
        }
      }
      const event = await Event.findOne(eventQuery);
      if (!event) {
        return res.status(404).json({ error: "Event not found" });
      }

      if (req.user.role === "school_admin" && event.school_id.toString() !== req.user.school_id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "district_admin") {
        const school = await School.findById(event.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "teacher" && event.teacher_id.toString() !== req.user.userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const student = await Student.findById(student_id);
      if (!student) {
        return res.status(404).json({ error: "Student not found" });
      }

      if (req.user.role === "school_admin" && student.school_id.toString() !== req.user.school_id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "district_admin") {
        const school = await School.findById(student.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }

      const existingRecord = await AttendanceRecord.findOne({
        student_id,
        event_name: trimmedEventName,
        school_id: event.school_id,
      });
      if (existingRecord) {
        return res.status(400).json({ error: "Attendance already recorded" });
      }

      const record = new AttendanceRecord({
        student_id,
        event_name: trimmedEventName,
        timestamp: new Date(timestamp),
        scanned_by,
        school_id: event.school_id,
        studentName: student.name,
      });
      await record.save();

      const historicalRecord = new HistoricalAttendanceRecord({
        student_id,
        event_name: trimmedEventName,
        timestamp: new Date(timestamp),
        scanned_by,
        school_id: event.school_id,
        studentName: student.name,
        archived_at: new Date(),
      });
      await historicalRecord.save();

      const populatedRecord = await AttendanceRecord.findById(record._id).populate(
        "student_id",
        "name"
      );
      res.json({
        _id: populatedRecord._id,
        student_id: populatedRecord.student_id._id,
        studentName: populatedRecord.student_id.name,
        event_name: populatedRecord.event_name,
        timestamp: populatedRecord.timestamp,
        scanned_by: populatedRecord.scanned_by,
      });
    } catch (err) {
      console.error("Error adding attendance:", err.message, err.stack);
      res.status(500).json({ error: "Error adding attendance", details: err.message });
    }
  }
);

app.delete(
  "/attendance/:id",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin", "teacher"]),
  async (req, res) => {
    try {
      const record = await AttendanceRecord.findById(req.params.id);
      if (!record) return res.status(404).json({ error: "Attendance record not found" });
      if (req.user.role === "school_admin" && record.school_id.toString() !== req.user.school_id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "district_admin") {
        const school = await School.findById(record.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      await AttendanceRecord.findByIdAndDelete(req.params.id);
      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting attendance:", err.message, err.stack);
      res.status(500).json({ error: "Error deleting attendance", details: err.message });
    }
  }
);

app.delete(
  "/attendance/event/:eventName/delete-all",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin", "teacher"]),
  async (req, res) => {
    try {
      const eventName = req.params.eventName;
      let eventQuery = { name: eventName };
      if (req.user.role !== "main_admin") {
        if (req.user.role === "district_admin") {
          const schools = await School.find({ city: req.user.city });
          const schoolIds = schools.map(s => s._id);
          eventQuery = { ...eventQuery, school_id: { $in: schoolIds } };
        } else {
          eventQuery = { ...eventQuery, school_id: req.user.school_id };
        }
      }
      const event = await Event.findOne(eventQuery);
      if (!event) return res.status(404).json({ error: "Event not found" });
      if (
        req.user.role === "school_admin" &&
        event.school_id.toString() !== req.user.school_id
      ) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "district_admin") {
        const school = await School.findById(event.school_id);
        if (school.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "teacher" && event.teacher_id.toString() !== req.user.userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      await AttendanceRecord.deleteMany({ event_name: eventName, school_id: event.school_id });
      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting all attendance by event:", err.message, err.stack);
      res.status(500).json({
        error: "Error deleting all attendance by event",
        details: err.message,
      });
    }
  }
);

// Analytics route
app.get("/analytics", authMiddleware, roleMiddleware(["main_admin", "school_admin", "district_admin"]), async (req, res) => {
  try {
    let schoolFilter = {};
    if (req.user.role === 'school_admin') {
      schoolFilter = { school_id: req.user.school_id };
    } else if (req.user.role === 'district_admin') {
      const schools = await School.find({ city: req.user.city });
      const schoolIds = schools.map(s => s._id);
      schoolFilter = { school_id: { $in: schoolIds } };
    }

    const totalUsers = await User.countDocuments(schoolFilter);

    const usersByRole = {
      teachers: await User.countDocuments({ ...schoolFilter, role: "teacher" }),
      parents: await User.countDocuments({ ...schoolFilter, role: "parent" }),
      students: await User.countDocuments({ ...schoolFilter, role: "student" }),
      schoolAdmins: await User.find({ ...schoolFilter, role: "school_admin" })
        .populate("school_id", "name")
        .select("email school_id")
        .then(admins => {
          // Filter out school admins with null school_id and log them
          const validAdmins = admins.filter(admin => {
            if (!admin.school_id) {
              console.warn(`School admin ${admin.email} has no school_id assigned`);
              return false;
            }
            return true;
          });
          return validAdmins.map(admin => ({
            _id: admin._id,
            email: admin.email,
            school_id: admin.school_id._id,
            school: admin.school_id.name // Ensure school name is included
          }));
        }),
      mainAdmins: (req.user.role === 'main_admin') ? await User.countDocuments({ role: "main_admin" }) : 0,
      districtAdmins: (req.user.role === 'main_admin') ? await User.countDocuments({ role: "district_admin" }) : 0,
    };

    const totalSchools = (req.user.role === 'school_admin') ? 1 : await School.countDocuments((req.user.role === 'district_admin') ? { city: req.user.city } : {});
    const totalStudents = await Student.countDocuments(schoolFilter);
    const totalEvents = await Event.countDocuments(schoolFilter);

    const totalAttendanceCurrent = await AttendanceRecord.countDocuments(schoolFilter);
    const totalAttendanceHistorical = await HistoricalAttendanceRecord.countDocuments(schoolFilter);
    const totalAttendance = totalAttendanceCurrent + totalAttendanceHistorical;

    const agg = [
      { $match: schoolFilter },
      { $group: { _id: "$school_id", count: { $sum: 1 } } },
      { $lookup: { from: "schools", localField: "_id", foreignField: "_id", as: "school" } },
      { $unwind: "$school" },
      { $project: { schoolName: "$school.name", count: 1 } }
    ];

    const currentBySchool = await AttendanceRecord.aggregate(agg);
    const historicalBySchool = await HistoricalAttendanceRecord.aggregate(agg);

    const bySchoolMap = new Map();
    for (const item of currentBySchool) {
      bySchoolMap.set(item.schoolName, (bySchoolMap.get(item.schoolName) || 0) + item.count);
    }
    for (const item of historicalBySchool) {
      bySchoolMap.set(item.schoolName, (bySchoolMap.get(item.schoolName) || 0) + item.count);
    }
    const attendanceBySchool = Array.from(bySchoolMap, ([schoolName, count]) => ({ schoolName, count }));

    res.json({
      totalUsers,
      usersByRole,
      totalSchools,
      totalStudents,
      totalEvents,
      totalAttendance,
      attendanceBySchool,
    });
  } catch (err) {
    console.error("Error fetching analytics:", err.message, err.stack);
    res.status(500).json({ error: "Error fetching analytics", details: err.message });
  }
});

// Get current user
app.get("/auth/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
      .populate("school_id", "name")
      .populate("children", "name group course");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    console.error("Error fetching current user:", err.message, err.stack);
    res.status(500).json({ error: "Error fetching current user", details: err.message });
  }
});

app.put(
  "/users/:id",
  authMiddleware,
  roleMiddleware(["school_admin", "main_admin"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { email, password, name, city } = req.body;

      const userToUpdate = await User.findById(id);
      if (!userToUpdate) {
        return res.status(404).json({ error: "User not found" });
      }
      if (req.user.role === "school_admin" && userToUpdate.school_id?.toString() !== req.user.school_id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (req.user.role === "district_admin") {
        if (userToUpdate.role === "district_admin") return res.status(403).json({ error: "Access denied" });
        const school = await School.findById(userToUpdate.school_id);
        if (school?.city !== req.user.city) return res.status(403).json({ error: "Access denied" });
      }

      const updateData = {};
      if (email) updateData.email = email;
      if (name) updateData.name = name;
      if (city) updateData.city = city;
      if (password) {
        updateData.password = password;
      }

      const updatedUser = await User.findByIdAndUpdate(id, updateData, { new: true });
      res.json({
        _id: updatedUser._id,
        email: updatedUser.email,
        role: updatedUser.role,
        createdAt: updatedUser.createdAt,
        name: updatedUser.name,
        children: updatedUser.children || [],
        city: updatedUser.city,
      });
    } catch (err) {
      console.error("Error updating user:", err);
      res.status(500).json({ error: err.message || "Internal server error" });
    }
  }
);

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});