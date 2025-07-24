require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const fileUpload = require('express-fileupload');
const path = require('path');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const app = express();

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
  slotId: mongoose.Schema.Types.ObjectId,
  section: { type: String, enum: ['A', 'B', 'C'] },
  timestamp: Date,
  fingerprint: { type: String, required: false }
});
const Attendance = mongoose.model('Attendance', attendanceSchema);

const slotSchema = new mongoose.Schema({
  year: { type: Number, enum: [1, 2, 3, 4] },
  sections: [{ type: String, enum: ['A', 'B', 'C'] }],
  slotNumber: { type: Number, enum: [1, 2, 3, 4, 5, 6, 7, 8] },
  qrToken: String,
  createdAt: Date,
  qrCreatedAt: Date,
  expiresAt: Date,
  facultyId: mongoose.Schema.Types.ObjectId,
  isActive: { type: Boolean, default: true }
});
const Slot = mongoose.model('Slot', slotSchema);

// Indexes for performance
studentSchema.index({ year: 1, section: 1 });
attendanceSchema.index({ rollNumber: 1, slotId: 1 });
attendanceSchema.index({ fingerprint: 1, slotId: 1 });
slotSchema.index({ year: 1, sections: 1, slotNumber: 1, createdAt: 1 });

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/sample-excel', async (req, res) => {
  const sampleData = [
    { rollNumber: 'CS101', name: 'John Doe', year: 1, section: 'A' },
    { rollNumber: 'CS102', name: 'Jane Smith', year: 1, section: 'B' }
  ];
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Students');
  worksheet.columns = [
    { header: 'rollNumber', key: 'rollNumber', width: 15 },
    { header: 'name', key: 'name', width: 20 },
    { header: 'year', key: 'year', width: 10 },
    { header: 'section', key: 'section', width: 10 }
  ];
  sampleData.forEach(row => worksheet.addRow(row));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=sample_students.xlsx');
  await workbook.xlsx.write(res);
  res.end();
});

app.post('/admin/upload-sheet', async (req, res) => {
  if (!req.files || !req.files.csvFile) {
    return res.status(400).json({ error: 'No Excel file uploaded' });
  }
  const excelFile = req.files.csvFile;
  if (!excelFile.name.endsWith('.xlsx')) {
    return res.status(400).json({ error: 'Please upload a valid .xlsx file' });
  }
  const students = [];
  const errors = [];
  const validYears = [1, 2, 3, 4];
  const validSections = ['A', 'B', 'C'];

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelFile.data);
    const worksheet = workbook.getWorksheet(1);
    if (!worksheet) {
      return res.status(400).json({ error: 'No worksheet found in Excel file' });
    }
    const header = worksheet.getRow(1).values;
    if (!header.includes('rollNumber') || !header.includes('name') || !header.includes('year') || !header.includes('section')) {
      return res.status(400).json({ error: 'Excel must have columns: rollNumber, name, year, section' });
    }
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header
      const rowData = row.values;
      const rollNumber = rowData[header.indexOf('rollNumber')]?.toString()?.trim();
      const name = rowData[header.indexOf('name')]?.toString()?.trim();
      const year = parseInt(rowData[header.indexOf('year')]);
      const section = rowData[header.indexOf('section')]?.toString()?.trim();
      if (!rollNumber || !name || !year || !section) {
        errors.push(`Row ${rowNumber}: Missing required fields`);
        return;
      }
      if (!validYears.includes(year)) {
        errors.push(`Row ${rowNumber}: Invalid year (${year}) - must be 1, 2, 3, or 4`);
        return;
      }
      if (!validSections.includes(section)) {
        errors.push(`Row ${rowNumber}: Invalid section (${section}) - must be A, B, or C`);
        return;
      }
      students.push({ rollNumber, name, year, section });
    });
    if (errors.length > 0) {
      return res.status(400).json({ error: `Excel processing errors: ${errors.join('; ')}` });
    }
    const batchSize = 100;
    for (let i = 0; i < students.length; i += batchSize) {
      const batch = students.slice(i, i + batchSize);
      await Student.insertMany(batch, { ordered: false }).catch(err => {
        if (err.code === 11000) {
          errors.push(`Batch ${i / batchSize + 1}: Duplicate roll numbers detected`);
        } else {
          errors.push(`Batch ${i / batchSize + 1}: ${err.message}`);
        }
      });
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: `Partial failure: ${errors.join('; ')}` });
    }
    res.json({ message: `${students.length} students uploaded successfully` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process Excel file: ' + err.message });
  }
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
    res.status(500).json({ error: err.code === 11000 ? 'Duplicate roll number' : 'Error adding student' });
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
    res.status(500).json({ error: err.code === 11000 ? 'Duplicate username' : 'Error adding faculty' });
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
          foreignField: '_id',
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
          facultyName: '$faculty.name',
          fingerprint: 1
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
      return res.status(400).json({ error: 'Missing rollNumber, qrToken, or fingerprint' });
    }
    const slot = await Slot.findOne({
      qrToken,
      qrCreatedAt: { $gte: new Date(Date.now() - 15 * 1000) },
      expiresAt: { $gte: new Date() },
      isActive: true
    });
    if (!slot) {
      return res.status(400).json({
        error: 'Invalid or expired QR code',
        details: 'The QR code is either invalid, older than 15 seconds, or the slot has expired.'
      });
    }
    const student = await Student.findOne({ rollNumber });
    if (!student) {
      return res.status(400).json({
        error: 'Student not found',
        details: `No student found with roll number ${rollNumber}.`
      });
    }
    if (!slot.sections.includes(student.section)) {
      return res.status(400).json({
        error: 'Student not in selected section',
        details: `Student ${rollNumber} is not in section(s) ${slot.sections.join(', ')} for this slot.`
      });
    }
    const existingDeviceAttendance = await Attendance.findOne({
      fingerprint,
      slotId: slot._id
    });
    if (existingDeviceAttendance) {
      return res.status(400).json({
        error: 'This device has already marked attendance for this slot',
        details: 'This device has already been used to mark attendance for this slot.'
      });
    }
    const existingRollAttendance = await Attendance.findOne({
      rollNumber,
      slotId: slot._id
    });
    if (existingRollAttendance) {
      return res.status(400).json({
        error: 'Attendance already recorded for this student',
        details: `Attendance for ${rollNumber} has already been recorded for this slot.`
      });
    }
    await Attendance.create({
      rollNumber,
      slotId: slot._id,
      section: student.section,
      timestamp: new Date(),
      fingerprint
    });
    const newQrToken = uuidv4();
    await Slot.updateOne(
      { _id: slot._id },
      { qrToken: newQrToken, qrCreatedAt: new Date() }
    );
    res.json({
      message: 'Successfully marked present',
      details: {
        rollNumber,
        slotNumber: slot.slotNumber,
        year: slot.year,
        sections: slot.sections,
        timestamp: new Date().toLocaleString()
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Failed to record attendance',
      details: 'An unexpected server error occurred.'
    });
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
      sections: { $in: sections },
      slotNumber: parseInt(slotNumber),
      createdAt: { $gte: today },
      isActive: true
    });
    if (existingSlot) {
      const assignedFaculty = await Faculty.findOne({ _id: existingSlot.facultyId });
      return res.status(400).json({
        error: `Slot ${slotNumber} for year ${year}, section(s) ${sections.join(', ')} is already assigned to ${assignedFaculty ? assignedFaculty.name : 'another faculty'}`
      });
    }
    const now = new Date();
    const qrToken = uuidv4();
    const slot = await Slot.create({
      year: parseInt(year),
      sections,
      slotNumber: parseInt(slotNumber),
      qrToken,
      createdAt: now,
      qrCreatedAt: now,
      expiresAt: new Date(now.getTime() + 45 * 1000),
      facultyId
    });
    const qrCode = await qrcode.toDataURL(`${process.env.BASE_URL}/scan/code?token=${qrToken}`);
    res.json({ qrCode, slotId: slot._id, slotExpiresAt: slot.expiresAt, attendedStudents: [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to start attendance' });
  }
});

app.post('/faculty/refresh-qr', async (req, res) => {
  try {
    const { slotId, facultyId , expiresAt } = req.body;
    if (!slotId || !facultyId) return res.status(400).json({ error: 'Missing required fields' });
    const slot = await Slot.findOne({ _id: slotId, facultyId, isActive: true });
    if (!slot) return res.status(400).json({ error: 'Invalid slot or unauthorized' });
    if (slot.expiresAt < new Date()) {
      await Slot.updateOne({ _id: slotId }, { isActive: false });
      const attendedStudents = await Attendance.find({ slotId }).lean();
      for (let record of attendedStudents) {
        const student = await Student.findOne({ rollNumber: record.rollNumber });
        record.name = student ? student.name : 'N/A';
        record.section = student ? student.section : 'N/A';
        record.timestamp = record.timestamp ? new Date(record.timestamp).toLocaleString() : 'N/A';
      }
      return res.json({ error: 'Slot expired', attendedStudents });
    }
    const qrToken = uuidv4();
    await Slot.updateOne({ _id: slotId }, { qrToken, qrCreatedAt: new Date() });
    const qrCode = await qrcode.toDataURL(`${process.env.BASE_URL}/scan/code?token=${qrToken}`);
    const attendedStudents = await Attendance.find({ slotId }).lean();
    for (let record of attendedStudents) {
      const student = await Student.findOne({ rollNumber: record.rollNumber });
      record.name = student ? student.name : 'N/A';
      record.section = student ? student.section : 'N/A';
      record.timestamp = record.timestamp ? new Date(record.timestamp).toLocaleString() : 'N/A';
    }
    res.json({ qrCode, slotExpiresAt: slot.expiresAt, attendedStudents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to refresh QR code' });
  }
});

app.post('/faculty/extend-slot', async (req, res) => {
  try {
    const { slotId, facultyId } = req.body;
    if (!slotId || !facultyId) return res.status(400).json({ error: 'Missing required fields' });
    const slot = await Slot.findOne({ _id: slotId, facultyId });
    if (!slot) return res.status(400).json({ error: 'Invalid slot or unauthorized' });
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + 45 * 1000);
    await Slot.updateOne(
      { _id: slotId },
      { expiresAt: newExpiresAt, isActive: true }
    );
    const qrToken = uuidv4();
    await Slot.updateOne({ _id: slotId }, { qrToken, qrCreatedAt: now });
    const qrCode = await qrcode.toDataURL(`${process.env.BASE_URL}/scan/code?token=${qrToken}`);
    const attendedStudents = await Attendance.find({ slotId }).lean();
    for (let record of attendedStudents) {
      const student = await Student.findOne({ rollNumber: record.rollNumber });
      record.name = student ? student.name : 'N/A';
      record.section = student ? student.section : 'N/A';
      record.timestamp = record.timestamp ? new Date(record.timestamp).toLocaleString() : 'N/A';
    }
    res.json({ qrCode, slotExpiresAt: newExpiresAt, attendedStudents, message: 'Slot extended by 45 seconds' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to extend slot' });
  }
});

app.post('/faculty/stop-slot', async (req, res) => {
  try {
    const { slotId, facultyId } = req.body;
    if (!slotId || !facultyId) return res.status(400).json({ error: 'Missing required fields' });
    const slot = await Slot.findOne({ _id: slotId, facultyId });
    if (!slot) return res.status(400).json({ error: 'Invalid slot or unauthorized' });
    await Slot.updateOne({ _id: slotId }, { isActive: false });
    const attendedStudents = await Attendance.find({ slotId }).lean();
    for (let record of attendedStudents) {
      const student = await Student.findOne({ rollNumber: record.rollNumber });
      record.name = student ? student.name : 'N/A';
      record.section = student ? student.section : 'N/A';
      record.timestamp = record.timestamp ? new Date(record.timestamp).toLocaleString() : 'N/A';
    }
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
      return res.status(400).json({ error: 'Missing required fields: facultyId, rollNumber, slotId' });
    }
    if (!mongoose.isValidObjectId(slotId)) {
      return res.status(400).json({ error: 'Invalid slotId. Must be a 24-character hex string.' });
    }
    const slot = await Slot.findOne({ _id: slotId, facultyId });
    if (!slot) {
      return res.status(400).json({ error: 'Invalid slot or unauthorized' });
    }
    const student = await Student.findOne({ rollNumber });
    if (!student || !slot.sections.includes(student.section) || student.year !== slot.year) {
      return res.status(400).json({ error: `Student ${rollNumber} is not in selected section (${slot.sections.join(', ')}) or year` });
    }
    const existingRollAttendance = await Attendance.findOne({
      rollNumber,
      slotId
    });
    if (existingRollAttendance) {
      return res.status(400).json({ error: 'Attendance already recorded for this student' });
    }
    await Attendance.create({
      rollNumber,
      slotId,
      section: student.section,
      timestamp: new Date()
    });
    res.json({ message: 'Manual attendance marked successfully' });
  } catch (err) {
    console.error(err);
    if (err.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid slotId. Must be a 24-character hex string.' });
    }
    res.status(500).json({ error: 'Failed to mark manual attendance' });
  }
});

app.get('/faculty/slots', async (req, res) => {
  try {
    const { facultyId, slotId } = req.query;
    if (!facultyId || !slotId) return res.status(400).json({ error: 'Faculty ID and slot ID required' });
    const slot = await Slot.findOne({ _id: slotId, facultyId });
    if (!slot) return res.json({ attendedStudents: [] });
    const attendedStudents = await Attendance.find({ slotId }).lean();
    for (let record of attendedStudents) {
      const student = await Student.findOne({ rollNumber: record.rollNumber });
      record.name = student ? student.name : 'N/A';
      record.section = student ? student.section : 'N/A';
      record.timestamp = record.timestamp ? new Date(record.timestamp).toLocaleString() : 'N/A';
    }
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
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const slots = await Slot.find({
      facultyId,
      year: parseInt(year),
      slotNumber: parseInt(slotNumber),
      sections: section
    });
    const slotIds = slots.map(slot => slot._id);
    const attendance = await Attendance.aggregate([
      {
        $match: {
          slotId: { $in: slotIds },
          section,
          timestamp: { $gte: start, $lt: end }
        }
      },
      {
        $lookup: {
          from: 'slots',
          localField: 'slotId',
          foreignField: '_id',
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
          section: 1,
          slotNumber: '$slot.slotNumber',
          name: '$student.name'
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

app.get('/faculty/download-attendance', async (req, res) => {
  try {
    const { facultyId, date, year, section, slotNumber } = req.query;
    if (!facultyId || !date || !year || !section || !slotNumber) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const slots = await Slot.find({
      facultyId,
      year: parseInt(year),
      slotNumber: parseInt(slotNumber),
      sections: section
    });
    const slotIds = slots.map(slot => slot._id);
    const attendance = await Attendance.find({
      slotId: { $in: slotIds },
      section,
      timestamp: { $gte: start, $lt: end }
    }).lean();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`Attendance_${date}_slot${slotNumber}`);
    worksheet.columns = [
      { header: 'Roll Number', key: 'rollNumber', width: 15 },
      { header: 'Name', key: 'name', width: 20 },
      { header: 'Section', key: 'section', width: 10 },
      { header: 'Timestamp', key: 'timestamp', width: 20 },
      { header: 'Slot', key: 'slotNumber', width: 10 }
    ];
    for (let record of attendance) {
      const student = await Student.findOne({ rollNumber: record.rollNumber });
      const slot = await Slot.findOne({ _id: record.slotId });
      worksheet.addRow({
        rollNumber: record.rollNumber,
        name: student ? student.name : 'N/A',
        section: record.section || 'N/A',
        timestamp: new Date(record.timestamp).toLocaleString(),
        slotNumber: slot ? slot.slotNumber : 'N/A'
      });
    }
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
    const slot = await Slot.findOne({ _id: slotId, facultyId });
    if (!slot) return res.status(400).json({ error: 'Invalid slot or unauthorized' });
    const attendance = await Attendance.find({ slotId }).lean();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Slot_Attendance');
    worksheet.columns = [
      { header: 'Roll Number', key: 'rollNumber', width: 15 },
      { header: 'Name', key: 'name', width: 20 },
      { header: 'Section', key: 'section', width: 10 },
      { header: 'Timestamp', key: 'timestamp', width: 20 },
      { header: 'Slot', key: 'slotNumber', width: 10 }
    ];
    for (let record of attendance) {
      const student = await Student.findOne({ rollNumber: record.rollNumber });
      worksheet.addRow({
        rollNumber: record.rollNumber,
        name: student ? student.name : 'N/A',
        section: record.section || 'N/A',
        timestamp: new Date(record.timestamp).toLocaleString(),
        slotNumber: slot.slotNumber
      });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=slot_attendance_${slotId}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generating slot attendance report' });
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
          foreignField: '_id',
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
          facultyName: '$faculty.name',
          fingerprint: 1
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
          foreignField: '_id',
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
          facultyName: '$faculty.name',
          fingerprint: 1
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
      { header: 'Faculty', key: 'facultyName', width: 20 },
      { header: 'Fingerprint', key: 'fingerprint', width: 20 }
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
        facultyName: record.facultyName || 'N/A',
        fingerprint: record.fingerprint || 'Manual'
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

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});