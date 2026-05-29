const express = require('express');
const jsforce = require('jsforce');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from root directory
app.use(express.static(path.join(__dirname)));

const REP_MAP = {
  '005aZ00000Oa6fN': 'Victoria G.',
  '005Hr00000HUOVE': 'Tony M.',
  '005aZ00000AB5GW': 'Rafael R.',
  '005Hr00000HUOUz': 'Benjamin S.',
  '005Hr00000IEPIB': 'John R.',
  '005aZ00000WYXOv': 'Miguel A.',
  '005aZ00000NRfg9': 'Charles F.',
  '005Hr00000IEPI6': 'Richard N.'
};

const OWNER_IDS = Object.keys(REP_MAP);

let sfConnection = null;
let lastData = null;
let lastFetch = null;

async function connectToSalesforce() {
  const conn = new jsforce.Connection({
    loginUrl: 'https://login.salesforce.com'
  });
  await conn.login(
    process.env.SF_USERNAME,
    process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN
  );
  sfConnection = conn;
  console.log('Connected to Salesforce');
  return conn;
}

async function fetchLeaderboardData() {
  try {
    if (!sfConnection) await connectToSalesforce();

    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const ownerIdList = OWNER_IDS.map(id => `'${id}'`).join(', ');

    const result = await sfConnection.query(`
      SELECT OwnerId,
             csbs__Underwriting_Date_Time__c,
             csbs__Approved_Date_Time__c,
             csbs__Funded_Date_Time__c,
             csbs__Funded__c
      FROM Opportunity
      WHERE OwnerId IN (${ownerIdList})
      AND CreatedDate >= ${firstOfMonth}
      AND (
        csbs__Underwriting_Date_Time__c != null
        OR csbs__Approved_Date_Time__c != null
        OR csbs__Funded_Date_Time__c != null
      )
    `);

    const stats = {};
    OWNER_IDS.forEach(id => {
      stats[REP_MAP[id]] = { submissions: 0, approvals: 0, funded: 0, fundedAmt: 0 };
    });

    result.records.forEach(rec => {
      const name = REP_MAP[rec.OwnerId];
      if (!name) return;
      if (rec.csbs__Underwriting_Date_Time__c) stats[name].submissions++;
      if (rec.csbs__Approved_Date_Time__c) stats[name].approvals++;
      if (rec.csbs__Funded_Date_Time__c) {
        stats[name].funded++;
        stats[name].fundedAmt += parseFloat(rec.csbs__Funded__c || 0);
      }
    });

    const newEvents = [];
    if (lastData) {
      Object.entries(stats).forEach(([name, curr]) => {
        const prev = lastData[name] || {};
        if (curr.submissions > (prev.submissions || 0)) newEvents.push({ rep: name, type: 'Submission', amount: 0 });
        if (curr.approvals > (prev.approvals || 0)) newEvents.push({ rep: name, type: 'Approval', amount: 0 });
        if (curr.funded > (prev.funded || 0)) {
          const newAmt = curr.fundedAmt - (prev.fundedAmt || 0);
          newEvents.push({ rep: name, type: 'Funded', amount: newAmt });
        }
      });
    }

    lastData = stats;
    lastFetch = new Date().toISOString();

    return { stats, newEvents, lastFetch, month: now.toLocaleString('default', { month: 'long', year: 'numeric' }) };
  } catch (err) {
    console.error('Salesforce error:', err.message);
    sfConnection = null;
    throw err;
  }
}

app.get('/api/data', async (req, res) => {
  try {
    const data = await fetchLeaderboardData();
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

let orumData = {
  monthly: Object.fromEntries(Object.values(REP_MAP).map(n => [n, 0])),
  weekly: Object.fromEntries(Object.values(REP_MAP).map(n => [n, 0])),
  leaders: { dials: null, connects: null, convos: null, meetings: null },
  feed: []
};

app.post('/api/orum', (req, res) => {
  const { leaders } = req.body;
  const tally = {};
  Object.values(leaders).forEach(rep => {
    if (rep) tally[rep] = (tally[rep] || 0) + 1;
  });
  Object.entries(tally).forEach(([rep, count]) => {
    const pts = count > 1 ? count * 0.5 : count;
    if (orumData.monthly[rep] !== undefined) orumData.monthly[rep] += pts;
    if (orumData.weekly[rep] !== undefined) orumData.weekly[rep] += pts;
  });
  orumData.leaders = leaders;
  res.json({ success: true, orumData });
});

app.get('/api/orum', (req, res) => {
  res.json({ success: true, orumData });
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Leaderboard running on port ${PORT}`));
