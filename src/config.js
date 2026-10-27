// Central business rules. Every number from the blueprint lives here so ops can tune policy
// without touching logic.
module.exports = {
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || require('path').join(__dirname, '..', 'data', 'jeta-crm.db'),

  // Currency: store the original, report AED / INR separately and combined at this rate.
  exchangeRate: { INR_PER_AED: Number(process.env.INR_PER_AED || 22.7) },
  currencyByCountry: { UAE: 'AED', India: 'INR' },

  leadSources: [
    'Instagram Organic', 'Instagram DM', 'Meta Ads', 'Google Ads', 'Website Form',
    'WhatsApp Inquiry', 'Referral', 'Walk-in/Event', 'School Tie-up',
    'Old Student Re-enquiry', 'Cold Call', 'Other',
  ],

  leadStages: [
    'New', 'Attempted', 'Contacted', 'Qualified', 'Demo Scheduled', 'Demo Done',
    'Negotiation', 'Payment Pending', 'Converted', 'Lost', 'Nurture',
  ],
  closedStages: ['Converted', 'Lost'],
  lostReasons: ['Price', 'No response', 'Competitor', 'Not interested', 'Wrong number', 'Other'],
  churnReasons: ['Price', 'Results', 'Teacher', 'Schedule', 'Moving', 'Other'],

  studentStages: [
    'Awaiting Teacher', 'Teacher Assigned', 'Scheduled', 'Active', 'Hours Low',
    'Completed', 'Renewed', 'Churned', 'Paused',
  ],
  retentionStages: ['Hours Low', 'Renewal Discussion', 'Payment Pending', 'Renewed', 'Churned'],

  boards: ['CBSE', 'ICSE', 'IGCSE', 'IB', 'State', 'Other'],
  packages: [5, 15, 20],
  maxBatchSize: 5,

  // Section 3.4 / 4 / 5 / 6
  sla: { firstCallMinutes: 15, assignTeacherHours: 24, unmarkedAttendanceHours: 48 },
  followUp: {
    remindBeforeMinutes: 30,
    ownerEscalateAfterMinutes: 60,
    managerEscalateAfterMinutes: 24 * 60,
    overdueBlockLimit: 10, // rep with more overdue follow-ups gets no new leads
  },
  reassignment: { warnDay: 25, expireDay: 30, maxReassignments: 2, demoExemptDays: 7 },
  maxFailedAttempts: 6,

  // Section 4: call outcome -> automatic action
  callOutcomes: {
    'Connected - Interested':      { stage: 'Contacted', requiresFollowUp: true },
    'Connected - Call back later': { requiresFollowUp: true },
    'Connected - Not interested':  { requiresLostReason: true },
    'Not answered':                { stage: 'Attempted', retryMinutes: 120, whatsappTask: true, failed: true },
    'Busy / Switched off':         { stage: 'Attempted', retryMinutes: 180, failed: true },
    'Wrong number':                { flag: true, failed: true },
  },
  // Not-connected cadence (6 tries, then Nurture):
  //   call 1 Day 0 → call 2 same day (outcome retry: +2h / +3h) → call 3 next day (different slot)
  //   → call 4 Day 3 (+ WhatsApp) → call 5 Day 5 → call 6 Day 7 → Nurture + manager alert.
  // Key = number of the NEXT call, value = day offset from the first call.
  cadenceDays: { 3: 1, 4: 3, 5: 5, 6: 7 },
  slotShiftHours: 3,               // "different time slot" for next-day retries
  whatsappAfterAttempts: [1, 3],   // WhatsApp template task after these failed calls

  // Section 10.4: attendance policy table
  attendancePolicy: {
    'Completed':                     { deductHours: true,  payTeacher: true },
    'Student Absent (no notice)':    { deductHours: true,  payTeacher: true },
    'Student Absent (notice given)': { deductHours: false, payTeacher: false },
    'Teacher Absent':                { deductHours: false, payTeacher: false },
    'Cancelled':                     { deductHours: false, payTeacher: false },
    'Rescheduled':                   { deductHours: false, payTeacher: false },
  },

  // Section 10.5
  hoursAlerts: { lowPct: 0.25, urgentPct: 0.10, urgentHours: 2 },
  checkInDays: [7, 30],
  instalmentReminderDaysBefore: 3,

  roles: {
    owner: 'Owner',
    sales_manager: 'Sales Manager',
    sales_exec: 'Sales Executive',
    admin: 'Admin / Ops',
    accounts: 'Accounts',
  },
};
