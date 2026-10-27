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
    'Busy':                        { stage: 'Attempted', retryMinutes: 180, failed: true },
    'Switched off':                { stage: 'Attempted', retryMinutes: 180, failed: true },
    'Wrong number':                { flag: true, failed: true },
  },
  // Conversation log (blueprint 5.2)
  interaction: {
    types: { call: 'Call', whatsapp: 'WhatsApp', demo: 'Demo', email: 'Email', walkin: 'Walk-in' },
    objections: ['Price', 'Timing', 'Trust', 'Competitor', 'Child not interested', 'Need to discuss', 'Other'],
    sentiments: ['Positive', 'Neutral', 'Negative'],
    minConnectedNoteChars: 60,      // "minimum 2 lines" – 2+ lines or 60+ characters
    noteDueMinutes: 10,             // tracker calls must get a note within 10 minutes
    managerAfterMinutes: 120,       // missing note escalates to the manager after this
  },
  tracker: { connectedSeconds: 20 },
  // Meet attendance rules (blueprint 11.4)
  meet: { presentPct: 0.8, mismatchMinutes: 10, auditPct: 0.10, pullAfterMinutes: 30 },   // a tracked call this long counts as connected
  escalation: { hours48Action: 'flag' }, // 'flag' (manager takes over) or 'reassign'
  compliance: {                       // scorecard targets; coaching after 2 weeks below
    notesPct: 90, onTimeFollowUpPct: 85, firstCallSlaPct: 90,
    teacherAssign24hPct: 95, exceptionsCleared24hPct: 90, kycVerified24hPct: 95,
    invoices24hPct: 98, payoutsOnTimePct: 100, payoutDueDays: 5,
  },
  summaryHourLocal: 20,               // 8 pm end-of-day summary (per market time zone)

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

  // Sales gamification. Outcomes are worth far more than activity, so the board rewards
  // selling, not dialling for the sake of it.
  game: {
    points: {
      call: 1,                 // any logged call
      connected: 2,            // extra when the parent picked up
      whatsappReply: 1,        // parent replied on WhatsApp
      fastFirstCall: 5,        // first call inside the 15-minute SLA
      demo: 10,                // moved a lead to Demo Scheduled
      conversion: 50,          // new student
      conversionPer100AED: 1,  // + 1 point per AED 100 of the sale
      renewal: 30,
      renewalPer200AED: 1,
      kudosReceived: 2,
    },
    maxCallsPerLeadPerDay: 3,  // stops call-spamming one lead for points
    defaults: { dailyCallTarget: 25, monthlyConversionGoal: 30, monthlyRevenueGoalAED: 60000 },
    weekend: { UAE: [0, 6], India: [0] }, // Sun/Sat – streaks skip these days
  },

  roles: {
    owner: 'Owner',
    sales_manager: 'Sales Manager',
    sales_exec: 'Sales Executive',
    admin: 'Admin / Ops',
    accounts: 'Accounts',
  },
};
