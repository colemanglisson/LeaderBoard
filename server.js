const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
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
let accessToken = null;
let lastData = null;
let lastFetch = null;

async function getAccessToken() {
  if (accessToken) return accessToken;

  const clientId = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;
  const instanceUrl = process.env.SF_INSTANCE_URL;

  // Try sending credentials in POST body (not Basic Auth header)
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);

  console.log('Attempting auth to:', `${instanceUrl}/services/oauth2/token`);
  console.log('Client ID starts with:', clientId ? clientId.substring(0, 10) + '...' : 'MISSING');
  console.log('Client Secret present:', !!clientSecret);

  const response = await fetch(`${instanceUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const text = await response.text();
  console.log('Auth response status:', response.status);
  console.log('Auth response:', text);

  if (!response.ok) throw new Error(`Auth failed: ${text}`);

  const data = JSON.parse(text);
  accessToken = data.access_token;
  console.log('Got access token successfully');
  return accessToken;
}

async function sfQuery(soql) {
  const token = await getAccessToken();
  const instanceUrl = process.env.SF_INSTANCE_URL;
  const url = `${instanceUrl}/services/data/v58.0/query?q=${encodeURIComponent(soql)}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (response.status === 401) {
    accessToken = null;
    return sfQuery(soql);
  }

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Query failed: ${err}`);
  }

  return response.json();
}

async function fetchLeaderboardData() {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const ownerIdList = OWNER_IDS.map(id => `'${id}'`).join(', ');

  const result = await sfQuery(`
    SELECT OwnerId, csbs__Underwriting_Date_Time__c, csbs__Approved_Date_Time__c,
           csbs__Funded_Date_Time__c, csbs__Funded__c
    FROM Opportunity
    WHERE OwnerId IN (${ownerIdList})
    AND CreatedDate >= ${firstOfMonth}
    AND (csbs__Underwriting_Date_Time__c != null
      OR csbs__Approved_Date_Time__c != null
      OR csbs__Funded_Date_Time__c != null)
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
      if (curr.funded > (prev.funded || 0)) newEvents.push({ rep: name, type: 'Funded', amount: curr.fundedAmt - (prev.fundedAmt || 0) });
    });
  }

  lastData = stats;
  lastFetch = new Date().toISOString();
  return { stats, newEvents, lastFetch, month: now.toLocaleString('default', { month: 'long', year: 'numeric' }) };
}

app.get('/api/data', async (req, res) => {
  try {
    const data = await fetchLeaderboardData();
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Debug endpoint to test auth without querying SF
app.get('/api/test-auth', async (req, res) => {
  try {
    accessToken = null; // force fresh token
    const token = await getAccessToken();
    res.json({ success: true, message: 'Auth successful', tokenPreview: token.substring(0, 20) + '...' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

let orumData = {
  monthly: Object.fromEntries(Object.values(REP_MAP).map(n => [n, 0])),
  weekly: Object.fromEntries(Object.values(REP_MAP).map(n => [n, 0])),
  leaders: { dials: null, connects: null, convos: null, meetings: null }
};

app.post('/api/orum', (req, res) => {
  const { leaders } = req.body;
  const tally = {};
  Object.values(leaders).forEach(rep => { if (rep) tally[rep] = (tally[rep] || 0) + 1; });
  Object.entries(tally).forEach(([rep, count]) => {
    const pts = count > 1 ? count * 0.5 : count;
    if (orumData.monthly[rep] !== undefined) orumData.monthly[rep] += pts;
    if (orumData.weekly[rep] !== undefined) orumData.weekly[rep] += pts;
  });
  orumData.leaders = leaders;
  res.json({ success: true, orumData });
});

app.get('/api/orum', (req, res) => res.json({ success: true, orumData }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
