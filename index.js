require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const fileUpload = require('express-fileupload');
const csv = require('csv-parser');

const path = require('path');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const app = express();

  const fs = require('fs'); // Standard fs for createReadStream
  const fsPromises = require('fs').promises; // fs.promises for async file operations
    const processedCsvDir = path.join(__dirname, 'processed_csv');
  fsPromises.mkdir(processedCsvDir, { recursive: true }).catch(err => console.error('Error creating processed_csv dir:', err));


// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(fileUpload());
app.use(express.json());
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Server error' });
});

// MongoDB Atlas Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

// Schemas
const studentSchema = new mongoose.Schema({
  rollNumber: { type: String, unique: true },
  name: String,
  year: { type: Number, enum: [1, 2, 3, 4] },
  section: { type: String, enum: ['A', 'B', 'C'] }
});
const Student = mongoose.model('Student', studentSchema);

const facultySchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  name: String
});
const Faculty = mongoose.model('Faculty', facultySchema);

const attendanceSchema = new mongoose.Schema({
  rollNumber: String,
  slotId: String,
  timestamp: Date,
  fingerprint: String
});
const Attendance = mongoose.model('Attendance', attendanceSchema);

const slotSchema = new mongoose.Schema({
  slotId: String,
  year: { type: Number, enum: [1, 2, 3, 4] },
  sections: [{ type: String, enum: ['A', 'B', 'C'] }],
  slotNumber: { type: Number, enum: [1, 2, 3, 4, 5, 6, 7, 8] },
  qrToken: String,
  createdAt: Date,
  facultyId: String,
  isActive: { type: Boolean, default: true }
});
const Slot = mongoose.model('Slot', slotSchema);

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/check-attendance', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'check-attendance.html'));
});

app.post('/check-attendance', async (req, res) => {
  try {
    const { rollNumber } = req.body;
    const { date } = req.query;
    if (!rollNumber) return res.status(400).json({ error: 'Roll number required' });
    let query = { rollNumber };
    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      query.timestamp = { $gte: start, $lt: end };
    }
    const attendance = await Attendance.aggregate([
      { $match: query },
      {
        $lookup: {
          from: 'slots',
          localField: 'slotId',
          foreignField: 'slotId',
          as: 'slot'
        }
      },
      { $unwind: { path: '$slot', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'students',
          localField: 'rollNumber',
          foreignField: 'rollNumber',
          as: 'student'
        }
      },
      { $unwind: { path: '$student', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          rollNumber: 1,
          timestamp: 1,
          slotId: 1,
          year: '$slot.year',
          sections: '$slot.sections',
          slotNumber: '$slot.slotNumber',
          name: '$student.name',
          section: '$student.section'
        }
      },
      { $sort: { timestamp: -1 } }
    ]);
    res.json({ attendance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

app.get('/scan/code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scan-code.html'));
});

app.post('/scan/code', async (req, res) => {
  try {
    const { rollNumber, qrToken, fingerprint } = req.body;
    if (!rollNumber || !qrToken || !fingerprint) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const slot = await Slot.findOne({
      qrToken,
      createdAt: { $gte: new Date(Date.now() - 45 * 1000) },
      isActive: true
    });
    if (!slot) return res.status(400).json({ error: 'Invalid or expired QR code' });
    const student = await Student.findOne({ rollNumber });
    if (!student || !slot.sections.includes(student.section)) {
      return res.status(400).json({ error: 'Student not in selected section' });
    }
    const existingDeviceAttendance = await Attendance.findOne({
      fingerprint,
      slotId: slot.slotId
    });
    if (existingDeviceAttendance) {
      return res.status(400).json({ error: 'This device has already been used to mark attendance for this slot' });
    }
    const existingRollAttendance = await Attendance.findOne({
      rollNumber,
      slotId: slot.slotId
    });
    if (existingRollAttendance) {
      return res.status(400).json({ error: 'Attendance already recorded for this student' });
    }
    await Attendance.create({
      rollNumber,
      slotId: slot.slotId,
      timestamp: new Date(),
      fingerprint
    });
    res.json({ message: 'Successfully marked present' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record attendance' });
  }
});

app.post('/faculty/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
    const faculty = await Faculty.findOne({ username });
    if (!faculty || !(await bcrypt.compare(password, faculty.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    res.json({ facultyId: faculty._id });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/faculty/start-attendance', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'faculty-start.html'));
});

app.post('/faculty/start-attendance', async (req, res) => {
  try {
    const { year, sections, slotNumber, facultyId } = req.body;
    if (!year || !sections || sections.length === 0 || !slotNumber || !facultyId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!sections.every(s => ['A', 'B', 'C'].includes(s))) {
      return res.status(400).json({ error: 'Invalid section selected' });
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const existingSlot = await Slot.findOne({
      year: parseInt(year),
      sections: { $all: sections },
      slotNumber: parseInt(slotNumber),
      createdAt: { $gte: today }
    });
    if (existingSlot) {
      return res.status(400).json({ error: `Slot ${slotNumber} for year ${year} section ${sections.join(', ')} is already taken today` });
    }
    const slotId = uuidv4();
    const qrToken = uuidv4();
    const qrCode = await qrcode.toDataURL(`${process.env.BASE_URL}/scan/code?token=${qrToken}`);
    await Slot.create({
      slotId,
      year: parseInt(year),
      sections,
      slotNumber: parseInt(slotNumber),
      qrToken,
      createdAt: new Date(),
      facultyId,
      isActive: true
    });
    const attendedStudents = await Attendance.aggregate([
      { $match: { slotId } },
      {
        $lookup: {
          from: 'students',
          localField: 'rollNumber',
          foreignField: 'rollNumber',
          as: 'student'
        }
      },
      { $unwind: '$student' },
      {
        $project: {
          rollNumber: 1,
          name: '$student.name',
          section: '$student.section'
        }
      }
    ]);
    res.json({ qrCode, slotId, qrToken, attendedStudents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

app.post('/faculty/refresh-qr', async (req, res) => {
  try {
    const { slotId, facultyId } = req.body;
    if (!slotId || !facultyId) return res.status(400).json({ error: 'Missing required fields' });
    const slot = await Slot.findOne({ slotId, facultyId, isActive: true });
    if (!slot) return res.status(400).json({ error: 'Invalid slot or unauthorized' });
    if (new Date() - slot.createdAt > 45 * 1000) {
      await Slot.updateOne({ slotId }, { isActive: false });
      const attendedStudents = await Attendance.aggregate([
        { $match: { slotId } },
        {
          $lookup: {
            from: 'students',
            localField: 'rollNumber',
            foreignField: 'rollNumber',
            as: 'student'
          }
        },
        { $unwind: '$student' },
        {
          $project: {
            rollNumber: 1,
            name: '$student.name',
            section: '$student.section'
          }
        }
      ]);
      res.json({ error: 'QR code expired', attendedStudents });
      return;
    }
    const qrToken = uuidv4();
    const qrCode = await qrcode.toDataURL(`${process.env.BASE_URL}/scan/code?token=${qrToken}`);
    await Slot.updateOne({ slotId }, { qrToken, createdAt: new Date() });
    const attendedStudents = await Attendance.aggregate([
      { $match: { slotId } },
      {
        $lookup: {
          from: 'students',
          localField: 'rollNumber',
          foreignField: 'rollNumber',
          as: 'student'
        }
      },
      { $unwind: '$student' },
      {
        $project: {
          rollNumber: 1,
          name: '$student.name',
          section: '$student.section'
        }
      }
    ]);
    res.json({ qrCode, qrToken, attendedStudents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to refresh QR code' });
  }
});

app.post('/faculty/stop-slot', async (req, res) => {
  try {
    const { slotId, facultyId } = req.body;
    if (!slotId || !facultyId) return res.status(400).json({ error: 'Missing required fields' });
    const slot = await Slot.findOne({ slotId, facultyId });
    if (!slot) return res.status(400).json({ error: 'Invalid slot or unauthorized' });
    await Slot.updateOne({ slotId }, { isActive: false });
    const attendedStudents = await Attendance.aggregate([
      { $match: { slotId } },
      {
        $lookup: {
          from: 'students',
          localField: 'rollNumber',
          foreignField: 'rollNumber',
          as: 'student'
        }
      },
      { $unwind: '$student' },
      {
        $project: {
          rollNumber: 1,
          name: '$student.name',
          section: '$student.section'
        }
      }
    ]);
    res.json({ message: 'Slot stopped', attendedStudents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error stopping slot' });
  }
});

 app.post('/faculty/manual-attendance', async (req, res) => {
    try {
      const { facultyId, rollNumber, slotId } = req.body;
      if (!facultyId || !rollNumber || !slotId) {
        return res.status(400).json({ error: 'Missing required fields: facultyId, rollNumber, and slotId are required' });
      }
      const slot = await Slot.findOne({ slotId, facultyId });
      if (!slot) {
        return res.status(400).json({ error: 'Invalid slot ID or you are not authorized to mark attendance for this slot' });
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (slot.createdAt < today) {
        return res.status(400).json({ error: 'Cannot mark manual attendance for slots from previous days' });
      }
      const student = await Student.findOne({ rollNumber });
      if (!student) {
        return res.status(400).json({ error: 'Student with this roll number does not exist' });
      }
      if (!slot.sections.includes(student.section)) {
        return res.status(400).json({ error: `Student ${rollNumber} is not in the selected section (${slot.sections.join(', ')})` });
      }
      const existingAttendance = await Attendance.findOne({ rollNumber, slotId });
      if (existingAttendance) {
        return res.status(400).json({ error: 'Attendance already recorded for this student in this slot' });
      }
      await Attendance.create({
        rollNumber,
        slotId,
        timestamp: new Date(),
        fingerprint: `manual_${rollNumber}_${slotId}`
      });
      res.json({ message: 'Manual attendance marked successfully' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to mark manual attendance due to a server error' });
    }
  });


app.get('/faculty/slots', async (req, res) => {
  try {
    const { facultyId, slotId } = req.query;
    if (!facultyId || !slotId) return res.status(400).json({ error: 'Faculty ID and slot ID required' });
    const slot = await Slot.findOne({ facultyId, slotId });
    if (!slot) return res.json({ attendedStudents: [] });
    const attendedStudents = await Attendance.aggregate([
      { $match: { slotId } },
      {
        $lookup: {
          from: 'students',
          localField: 'rollNumber',
          foreignField: 'rollNumber',
          as: 'student'
        }
      },
      { $unwind: '$student' },
      {
        $project: {
          rollNumber: 1,
          name: '$student.name',
          section: '$student.section'
        }
      }
    ]);
    res.json({ attendedStudents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching slot data' });
  }
});

app.get('/faculty/attendance', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'faculty-start.html'));
});

  app.post('/faculty/attendance', async (req, res) => {
    try {
      const { facultyId, year, section, slotNumber } = req.body;
      const { date } = req.query;
      if (!facultyId || !date || !year || !section || !slotNumber) {
        return res.status(400).json({ error: 'Faculty ID, date, year, section, and slot number are required' });
      }
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      const attendance = await Attendance.aggregate([
        {
          $match: {
            timestamp: { $gte: start, $lt: end }
          }
        },
        {
          $lookup: {
            from: 'slots',
            localField: 'slotId',
            foreignField: 'slotId',
            as: 'slot'
          }
        },
        { $unwind: { path: '$slot', preserveNullAndEmptyArrays: true } },
        {
          $match: {
            'slot.facultyId': facultyId,
            'slot.year': parseInt(year),
            'slot.sections': { $in: [section] },
            'slot.slotNumber': parseInt(slotNumber)
          }
        },
        {
          $lookup: {
            from: 'students',
            localField: 'rollNumber',
            foreignField: 'rollNumber',
            as: 'student'
          }
        },
        { $unwind: { path: '$student', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            rollNumber: 1,
            timestamp: 1,
            slotId: 1,
            year: '$slot.year',
            sections: '$slot.sections',
            slotNumber: '$slot.slotNumber',
            name: '$student.name',
            section: '$student.section'
          }
        },
        { $sort: { timestamp: -1 } }
      ]);
      res.json({ attendance });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch attendance due to a server error' });
    }
  });



  app.get('/faculty/download-attendance', async (req, res) => {
    try {
      const { facultyId, date, year, section, slotNumber } = req.query;
      if (!facultyId || !date || !year || !section || !slotNumber) {
        return res.status(400).json({ error: 'Faculty ID, date, year, section, and slot number are required' });
      }
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      const attendance = await Attendance.aggregate([
        {
          $match: {
            timestamp: { $gte: start, $lt: end }
          }
        },
        {
          $lookup: {
            from: 'slots',
            localField: 'slotId',
            foreignField: 'slotId',
            as: 'slot'
          }
        },
        { $unwind: { path: '$slot', preserveNullAndEmptyArrays: true } },
        {
          $match: {
            'slot.facultyId': facultyId,
            'slot.year': parseInt(year),
            'slot.sections': { $in: [section] },
            'slot.slotNumber': parseInt(slotNumber)
          }
        },
        {
          $lookup: {
            from: 'students',
            localField: 'rollNumber',
            foreignField: 'rollNumber',
            as: 'student'
          }
        },
        { $unwind: { path: '$student', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            rollNumber: 1,
            name: '$student.name',
            section: '$student.section',
            timestamp: 1,
            year: '$slot.year',
            sections: '$slot.sections',
            slotNumber: '$slot.slotNumber'
          }
        }
      ]);

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet(`Attendance_${date}_slot${slotNumber}`);
      worksheet.columns = [
        { header: 'Roll Number', key: 'rollNumber', width: 15 },
        { header: 'Name', key: 'name', width: 20 },
        { header: 'Section', key: 'section', width: 10 },
        { header: 'Date', key: 'timestamp', width: 20 },
        { header: 'Year', key: 'year', width: 10 },
        { header: 'Sections', key: 'sections', width: 15 },
        { header: 'Slot', key: 'slotNumber', width: 10 }
      ];
      attendance.forEach(record => {
        worksheet.addRow({
          rollNumber: record.rollNumber,
          name: record.name || 'N/A',
          section: record.section || 'N/A',
          timestamp: new Date(record.timestamp).toLocaleDateString(),
          year: record.year || 'N/A',
          sections: record.sections ? record.sections.join(', ') : 'N/A',
          slotNumber: record.slotNumber || 'N/A'
        });
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=attendance_${date}_year${year}_section${section}_slot${slotNumber}.xlsx`);
      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Error generating report' });
    }
  });
app.get('/faculty/download-slot-attendance', async (req, res) => {
  try {
    const { facultyId, slotId } = req.query;
    if (!facultyId || !slotId) return res.status(400).json({ error: 'Faculty ID and slot ID required' });
    const slot = await Slot.findOne({ slotId, facultyId });
    if (!slot) return res.status(400).json({ error: 'Invalid slot or unauthorized' });
    const attendance = await Attendance.aggregate([
      { $match: { slotId } },
      {
        $lookup: {
          from: 'students',
          localField: 'rollNumber',
          foreignField: 'rollNumber',
          as: 'student'
        }
      },
      { $unwind: '$student' },
      {
        $project: {
          rollNumber: 1,
          name: '$student.name',
          section: '$student.section',
          timestamp: 1
        }
      }
    ]);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Slot_Attendance');
    worksheet.columns = [
      { header: 'Roll Number', key: 'rollNumber', width: 15 },
      { header: 'Name', key: 'name', width: 20 },
      { header: 'Section', key: 'section', width: 10 },
      { header: 'Date', key: 'timestamp', width: 20 }
    ];
    attendance.forEach(record => {
      worksheet.addRow({
        rollNumber: record.rollNumber,
        name: record.name || 'N/A',
        section: record.section || 'N/A',
        timestamp: new Date(record.timestamp).toLocaleDateString()
      });
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=slot_attendance_${slotId}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generating slot attendance report' });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/admin/add-student', async (req, res) => {
  try {
    const { rollNumber, name, year, section } = req.body;
    if (!rollNumber || !name || !year || !section) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    await Student.create({ rollNumber, name, year: parseInt(year), section });
    res.json({ message: 'Student added successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error adding student' });
  }
});

app.post('/admin/edit-student', async (req, res) => {
  try {
    const { rollNumber, name, year, section } = req.body;
    if (!rollNumber) return res.status(400).json({ error: 'Roll number required' });
    await Student.updateOne(
      { rollNumber },
      { name, year: parseInt(year), section },
      { upsert: false }
    );
    res.json({ message: 'Student updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error updating student' });
  }
});

app.post('/admin/delete-student', async (req, res) => {
  try {
    const { rollNumber } = req.body;
    if (!rollNumber) return res.status(400).json({ error: 'Roll number required' });
    await Student.deleteOne({ rollNumber });
    res.json({ message: 'Student deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error deleting student' });
  }
});

app.post('/admin/add-faculty', async (req, res) => {
  try {
    const { username, password, name } = req.body;
    if (!username || !password || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await Faculty.create({ username, password: hashedPassword, name });
    res.json({ message: 'Faculty added successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error adding faculty' });
  }
});

app.post('/admin/edit-faculty', async (req, res) => {
  try {
    const { username, name, password } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const update = { name };
    if (password) update.password = await bcrypt.hash(password, 10);
    await Faculty.updateOne({ username }, update, { upsert: false });
    res.json({ message: 'Faculty updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error updating faculty' });
  }
});

app.post('/admin/delete-faculty', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    await Faculty.deleteOne({ username });
    res.json({ message: 'Faculty deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error deleting faculty' });
  }
});

app.get('/admin/students', async (req, res) => {
  try {
    const { year, section } = req.query;
    let query = {};
    if (year) query.year = parseInt(year);
    if (section) query.section = section;
    const students = await Student.find(query).sort({ rollNumber: 1 });
    res.json({ students });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching students' });
  }
});

app.get('/admin/faculty', async (req, res) => {
  try {
    const faculty = await Faculty.find({}, 'username name').sort({ username: 1 });
    res.json({ faculty });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching faculty' });
  }
});

app.get('/admin/attendance', async (req, res) => {
  try {
    const { rollNumber, year, section, date, slotNumber } = req.query;
    if (!date) return res.status(400).json({ error: 'Date is required' });
    let query = {};
    if (rollNumber) query.rollNumber = rollNumber;
    if (year) query['slot.year'] = parseInt(year);
    if (section) query['slot.sections'] = { $in: [section] };
    if (slotNumber) query['slot.slotNumber'] = parseInt(slotNumber);
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    query.timestamp = { $gte: start, $lt: end };
    const attendance = await Attendance.aggregate([
      { $match: query },
      {
        $lookup: {
          from: 'slots',
          localField: 'slotId',
          foreignField: 'slotId',
          as: 'slot'
        }
      },
      { $unwind: { path: '$slot', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'students',
          localField: 'rollNumber',
          foreignField: 'rollNumber',
          as: 'student'
        }
      },
      { $unwind: { path: '$student', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'faculties',
          localField: 'slot.facultyId',
          foreignField: '_id',
          as: 'faculty'
        }
      },
      { $unwind: { path: '$faculty', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          rollNumber: 1,
          timestamp: 1,
          slotId: 1,
          year: '$slot.year',
          sections: '$slot.sections',
          slotNumber: '$slot.slotNumber',
          name: '$student.name',
          section: '$student.section',
          facultyName: '$faculty.name'
        }
      },
      { $sort: { timestamp: -1 } }
    ]);
    res.json({ attendance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch attendance due to a server error' });
  }
});

app.get('/admin/download-attendance', async (req, res) => {
  try {
    const { rollNumber, year, section, date, slotNumber } = req.query;
    if (!date) return res.status(400).json({ error: 'Date is required' });
    let query = {};
    if (rollNumber) query.rollNumber = rollNumber;
    if (year) query['slot.year'] = parseInt(year);
    if (section) query['slot.sections'] = { $in: [section] };
    if (slotNumber) query['slot.slotNumber'] = parseInt(slotNumber);
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    query.timestamp = { $gte: start, $lt: end };

    const attendance = await Attendance.aggregate([
      { $match: query },
      {
        $lookup: {
          from: 'slots',
          localField: 'slotId',
          foreignField: 'slotId',
          as: 'slot'
        }
      },
      { $unwind: { path: '$slot', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'students',
          localField: 'rollNumber',
          foreignField: 'rollNumber',
          as: 'student'
        }
      },
      { $unwind: { path: '$student', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'faculties',
          localField: 'slot.facultyId',
          foreignField: '_id',
          as: 'faculty'
        }
      },
      { $unwind: { path: '$faculty', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          rollNumber: 1,
          timestamp: 1,
          year: '$slot.year',
          sections: '$slot.sections',
          slotNumber: '$slot.slotNumber',
          name: '$student.name',
          section: '$student.section',
          facultyName: '$faculty.name'
        }
      }
    ]);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`Attendance_${date}`);
    worksheet.columns = [
      { header: 'Roll Number', key: 'rollNumber', width: 15 },
      { header: 'Name', key: 'name', width: 20 },
      { header: 'Section', key: 'section', width: 10 },
      { header: 'Date', key: 'timestamp', width: 20 },
      { header: 'Year', key: 'year', width: 10 },
      { header: 'Sections', key: 'sections', width: 15 },
      { header: 'Slot', key: 'slotNumber', width: 10 },
      { header: 'Faculty', key: 'facultyName', width: 20 }
    ];
    attendance.forEach(record => {
      worksheet.addRow({
        rollNumber: record.rollNumber,
        name: record.name || 'N/A',
        section: record.section || 'N/A',
        timestamp: new Date(record.timestamp).toLocaleDateString(),
        year: record.year || 'N/A',
        sections: record.sections ? record.sections.join(', ') : 'N/A',
        slotNumber: record.slotNumber || 'N/A',
        facultyName: record.facultyName || 'N/A'
      });
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=attendance_${date}${slotNumber ? '_slot' + slotNumber : ''}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generating report' });
  }
});

  app.post('/admin/upload-sheet', async (req, res) => {
    try {
      if (!req.files || !req.files.csvFile) {
        return res.status(400).json({ error: 'No CSV file uploaded' });
      }
      const csvFile = req.files.csvFile;
      const students = [];
      const results = [];
      const rollNumberRegex = /^5[0-9]{2}[0-9]{6}$/;
      const validYears = [1, 2, 3, 4];
      const validSections = ['A', 'B', 'C'];

      // Parse CSV
      await new Promise((resolve, reject) => {
        fs.createReadStream(csvFile.tempFilePath)
          .pipe(csv({ columns: true, skip_empty_lines: true }))
          .on('data', (row) => {
            const rollNumber = row.rollNumber?.trim();
            const name = row.name?.trim();
            const year = parseInt(row.year);
            const section = row.section?.trim();

            // Validate row
            let error = null;
            if (!rollNumber || !rollNumberRegex.test(rollNumber)) {
              error = `Invalid rollNumber format: ${rollNumber || 'missing'}`;
            } else if (!name) {
              error = 'Missing name';
            } else if (!validYears.includes(year)) {
              error = `Invalid year: ${year || 'missing'}`;
            } else if (!validSections.includes(section)) {
              error = `Invalid section: ${section || 'missing'}`;
            }

            if (error) {
              results.push({ rollNumber, name, year, section, status: 'Failed', error });
              return;
            }

            students.push({ rollNumber, name, year, section });
            results.push({ rollNumber, name, year, section, status: 'Success', error: '' });
          })
          .on('end', resolve)
          .on('error', reject);
      });

      if (students.length === 0) {
        return res.status(400).json({ error: 'No valid student data in CSV' });
      }

      // Insert valid students
      try {
        await Student.insertMany(students, { ordered: false });
      } catch (err) {
        // Handle duplicate rollNumbers
        results.forEach(result => {
          if (result.status === 'Success' && err.writeValue?.rollNumber === result.rollNumber) {
            result.status = 'Failed';
            result.error = 'Duplicate rollNumber';
          }
        });
      }

      // Generate processed CSV
      const fileId = uuidv4();
      const outputFile = path.join(processedCsvDir, `${fileId}.csv`);
      let csvContent = 'rollNumber,name,year,section,status,error\n';
      results.forEach(result => {
        csvContent += `"${result.rollNumber || ''}","${result.name || ''}",${result.year || ''},"${result.section || ''}","${result.status}","${result.error}"\n`;
      });
      await fsPromises.writeFile(outputFile, csvContent);

      // Clean up old CSV files after 30 minutes
      setTimeout(() => fsPromises.unlink(outputFile).catch(err => console.error('Error deleting CSV:', err)), 30 * 60 * 1000);

      res.json({ message: `Processed ${results.length} records (${students.length} successful)`, fileId });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Error processing CSV' });
    }
  });


  app.get('/admin/download-processed-csv', async (req, res) => {
    try {
      const { fileId } = req.query;
      if (!fileId) {
        return res.status(400).json({ error: 'Missing fileId' });
      }
      const filePath = path.join(processedCsvDir, `${fileId}.csv`);
      if (!(await fsPromises.access(filePath).then(() => true).catch(() => false))) {
        return res.status(404).json({ error: 'Processed CSV not found' });
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=processed_students_${fileId}.csv`);
      res.sendFile(filePath, err => {
        if (err) {
          console.error(err);
          res.status(500).json({ error: 'Error downloading CSV' });
        }
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Error downloading CSV' });
    }
  });

app.post('/admin/upload-sheet', async (req, res) => {
  try {
    if (!req.files || !req.files.csvFile) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }
    const csvFile = req.files.csvFile;
    const students = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(csvFile.tempFilePath)
        .pipe(csv())
        .on('data', (row) => {
          if (!row.rollNumber || !row.name || !row.year || !['A', 'B', 'C'].includes(row.section)) {
            return;
          }
          students.push({
            rollNumber: row.rollNumber,
            name: row.name,
            year: parseInt(row.year),
            section: row.section
          });
        })
        .on('end', resolve)
        .on('error', reject);
    });
    if (students.length === 0) {
      return res.status(400).json({ error: 'Invalid CSV format or no valid data' });
    }
    await Student.insertMany(students, { ordered: false });
    res.json({ message: 'Bulk upload successful' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error uploading students' });
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});