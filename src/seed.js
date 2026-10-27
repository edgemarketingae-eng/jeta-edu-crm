// Demo data so every module and dashboard has something to show.
// `npm run seed` wipes the database and reseeds. All demo passwords: jeta1234
const fs = require('fs');
const config = require('./config');
const { q, insert, update, db } = require('./db');
const { hashPassword } = require('./auth');
const { now, addDays, addMinutes } = require('./util');

function seed() {
  const L = require('./services/leads');
  const S = require('./services/students');
  const F = require('./services/finance');
  const pw = hashPassword('jeta1234');
  const u = (name, email, role, market) => insert('users', { name, email, password_hash: pw, role, market, created_at: now() });
  const owner = u('Sreehari (Owner)', 'owner@jeta.edu', 'owner', null);
  u('Maya – Sales Manager', 'manager@jeta.edu', 'sales_manager', null);
  u('Aisha – Sales UAE', 'aisha@jeta.edu', 'sales_exec', 'UAE');
  u('Rahul – Sales UAE', 'rahul@jeta.edu', 'sales_exec', 'UAE');
  u('Priya – Sales India', 'priya@jeta.edu', 'sales_exec', 'India');
  u('Arjun – Sales India', 'arjun@jeta.edu', 'sales_exec', 'India');
  const admin = u('Nimmy – Operations Lead', 'admin@jeta.edu', 'admin', null);
  u('Faisal – Accounts', 'accounts@jeta.edu', 'accounts', null);
  const ownerU = q.get('SELECT * FROM users WHERE id=?', owner);
  const adminU = q.get('SELECT * FROM users WHERE id=?', admin);

  const teacher = (name, country, subjects, grades, rate) => insert('teachers', {
    name, country, currency: config.currencyByCountry[country], subjects, grades, boards: 'CBSE,ICSE',
    availability: 'Mon-Fri 4pm-9pm', rate_per_hour: rate, demo_rate: Math.round(rate * 0.5),
    bank_details: 'Bank: ****1234', phone: '+000000000', status: 'Active', created_at: now() });
  const tMath = teacher('Anjali Menon', 'India', 'Maths,Physics', '8,9,10,11,12', 450);
  const tSci = teacher('Deepak Nair', 'India', 'Chemistry,Biology,Science', '6,7,8,9,10', 400);
  teacher('Sara Thomas', 'UAE', 'English,Social Science', '5,6,7,8,9,10', 60);
  const tUaeMath = teacher('Omar Khalid', 'UAE', 'Maths,Science', '6,7,8,9,10', 75);

  const first = ['Fathima', 'Ravi', 'Neha', 'Salman', 'Divya', 'Anil', 'Meera', 'Joseph', 'Shabna', 'Vivek', 'Lakshmi', 'Imran',
    'Reshma', 'Sanjay', 'Hiba', 'Kiran', 'Asha', 'Nikhil', 'Rubina', 'Manoj', 'Sneha', 'Harish', 'Zainab', 'Prakash', 'Anu', 'Tariq'];
  const kids = ['Aarav', 'Diya', 'Ayaan', 'Ishaan', 'Anika', 'Zara', 'Rohan', 'Myra', 'Kabir', 'Sara', 'Adam', 'Nila', 'Arjun'];
  const subjects = ['Maths', 'Science', 'Maths,Physics', 'Chemistry', 'English', 'Biology', 'Maths,Science'];
  const created = [];
  first.forEach((name, i) => {
    const country = i % 2 === 0 ? 'India' : 'UAE';
    const lead = L.createLead({
      source: config.leadSources[i % config.leadSources.length], campaign: i % 2 ? 'Oct Exam Prep' : 'Back to School',
      referral_by: config.leadSources[i % config.leadSources.length] === 'Referral' ? 'Existing parent' : undefined,
      parent_name: `${name} ${['K', 'P', 'M', 'R'][i % 4]}`, phone: `+9715${String(10000000 + i * 7919).slice(0, 8)}`,
      email: `${name.toLowerCase()}@example.com`, city: country === 'UAE' ? ['Dubai', 'Sharjah', 'Abu Dhabi'][i % 3] : ['Kochi', 'Bangalore'][i % 2],
      child_name: kids[i % kids.length], grade: String(6 + (i % 7)), board: i % 2 ? 'CBSE' : 'ICSE', subjects: subjects[i % subjects.length],
      country, score: ['Hot', 'Warm', 'Cold'][i % 3],
    }, ownerU);
    // Backdate creation/assignment across the last ~35 days
    const back = addDays(now(), -(i * 1.1));
    update('leads', lead.id, { created_at: back, assigned_at: back });
    created.push(q.get('SELECT * FROM leads WHERE id=?', lead.id));
  });
  const repOf = (l) => q.get('SELECT * FROM users WHERE id=?', l.owner_id);

  created.forEach((l, i) => {
    const rep = repOf(l);
    const plan = i % 9;
    if (plan === 0) return; // stays New
    if (plan === 1) { L.logCall(l.id, { outcome: 'Not answered', notes: 'No answer' }, rep); return; }
    L.logCall(l.id, { outcome: 'Connected - Interested', notes: 'Wants support before mid-terms', duration_min: 6,
      follow_up_at: addMinutes(now(), (i % 4 === 0 ? -90 : 60 * (i % 30))), follow_up_type: 'call' }, rep);
    L.saveCallNotes(l.id, { child: `${l.child_name}, Grade ${l.grade} ${l.board}`, parent: 'Engineer, works till 6pm',
      subjects: `${l.subjects} – weak on concepts`, current: 'Group tuition, too crowded', timing: 'Weekdays 6–8pm, 15 hrs', decision: 'Both parents, start next week' }, rep);
    if (plan === 2) return;
    if (plan === 3) { L.changeStage(l.id, { stage: 'Lost', lost_reason: ['Price', 'Competitor', 'No response'][i % 3] }, rep); return; }
    L.changeStage(l.id, { stage: 'Qualified', follow_up_at: addDays(now(), 1), follow_up_type: 'demo' }, rep);
    if (plan === 4) return;
    L.changeStage(l.id, { stage: 'Demo Scheduled', demo_at: addDays(now(), 2), follow_up_at: addDays(now(), 2), follow_up_type: 'demo' }, rep);
    if (plan === 5) return;
    L.changeStage(l.id, { stage: 'Payment Pending', follow_up_at: addDays(now(), 1), follow_up_type: 'payment' }, rep);
    if (plan === 6) return;
    // Convert the rest
    L.saveKyc(l.id, { parent_full_name: l.parent_name, relationship: 'Mother', id_type: l.country === 'UAE' ? 'Emirates ID' : 'Aadhaar',
      id_number: '784-XXXX', id_file: 'emirates-id.pdf', whatsapp: l.phone, address: l.city, child_full_name: `${l.child_name} ${l.parent_name.split(' ')[1]}`,
      child_dob: '2012-05-10', school_name: 'Our Own School', occupation: 'Engineer', consent_terms: 1, consent_recording: 1, consent_data: 1,
      enrollment_file: 'enrollment-signed.pdf', submit: true }, rep);
    L.verifyKyc(l.id, { approve: true }, adminU);
    const hours = i === 25 ? 5 : config.packages[i % 3];
    const price = l.country === 'UAE' ? hours * 90 : hours * 900;
    const conv = L.convert(l.id, { subjects: l.subjects, hours, price, payment: { method: 'Bank transfer', reference: `TXN${1000 + i}`, amount: price } }, rep);
    const sid = conv.student_id;
    const backJoin = addDays(now(), -20);
    update('students', sid, { joined_at: backJoin });
    q.run("UPDATE payments SET paid_at=? WHERE student_id=?", addDays(now(), -18 + (i % 5)), sid);
    if (i % 4 === 3) return; // awaiting teacher
    const tid = l.country === 'India' ? (l.subjects.includes('Maths') ? tMath : tSci) : tUaeMath;
    S.assignTeacher(sid, { teacher_id: tid, batch_type: i % 2 ? 'Batch' : '1:1', batch_name: i % 2 ? 'Evening Batch A' : undefined, start_date: backJoin.slice(0, 10) }, adminU);
    // Past classes, marked
    const statuses = ['Completed', 'Completed', 'Completed', 'Student Absent (no notice)', 'Completed', 'Teacher Absent', 'Completed', 'Completed'];
    const pastCount = Math.min(hours - 1, 6 + (i % 6));
    for (let k = 0; k < pastCount; k++) {
      const at = addMinutes(addDays(now(), -(pastCount - k) * 2 - 1), (i * 37) % 600);
      const cid = insert('classes', { student_id: sid, teacher_id: tid, subject: l.subjects.split(',')[0], scheduled_at: at, duration_hours: 1, status: 'Scheduled', created_at: now() });
      const st = statuses[k % statuses.length];
      S.markAttendance(cid, { status: st, topic: `Chapter ${k + 1}`, remarks: st === 'Teacher Absent' ? 'Teacher unwell' : '',
        reschedule_to: st === 'Teacher Absent' ? addMinutes(addDays(now(), 15 + k), i * 131) : undefined, reschedule_reason: st === 'Teacher Absent' ? 'Teacher unwell' : undefined }, adminU);
    }
    S.schedule(sid, { days: ['Mon', 'Wed', 'Fri'], time: l.country === 'India' ? '18:30' : '17:00', weeks: 2, duration_hours: 1 }, adminU);
  });

  // One unmarked past class for the 48h alert, one instalment due soon, expenses
  const anyStudent = q.get("SELECT * FROM students WHERE teacher_id IS NOT NULL LIMIT 1");
  if (anyStudent) {
    insert('classes', { student_id: anyStudent.id, teacher_id: anyStudent.teacher_id, subject: 'Maths', scheduled_at: addDays(now(), -3), duration_hours: 1, status: 'Scheduled', created_at: now() });
    F.recordPayment({ student_id: anyStudent.id, amount: anyStudent.currency === 'AED' ? 450 : 4500, currency: anyStudent.currency, due_date: addDays(now(), 2).slice(0, 10), status: 'Pending', instalment_no: 2 }, ownerU);
  }
  const month = now().slice(0, 7);
  [['Ad Spend', 'Meta Ads', 3500, 'AED'], ['Ad Spend', 'Google Ads', 1800, 'AED'], ['Ad Spend', 'Meta Ads', 25000, 'INR'],
    ['Tools', null, 450, 'AED'], ['Salaries', null, 18000, 'AED']].forEach(([category, source, amount, currency]) =>
    F.addExpense({ category, source, amount, currency, month, note: 'Demo' }));
  F.generatePayouts(month);
  // A 2nd-reassignment candidate (old lead for the 30-day rule demo)
  const old = created.find((l) => q.get('SELECT stage FROM leads WHERE id=?', l.id).stage === 'Qualified');
  if (old) update('leads', old.id, { assigned_at: addDays(now(), -26) });
  q.run('DELETE FROM notifications'); // start clean; automation regenerates live alerts
}

if (require.main === module) {
  if (process.argv.includes('--reset')) {
    const file = config.dbPath;
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  db();
  seed();
  require('./automation').runAll();
  console.log('Seeded. Login with owner@jeta.edu / jeta1234 (see README for all roles).');
}

module.exports = { seed };
