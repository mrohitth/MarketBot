// Budget Update Script — runs nightly 11:30 PM ET
// Scans Gmail for Discover transactions, logs summary to daily memory
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { scanGmailForDiscoverAlerts, gmailToTransaction } = require('../dist/lib/gmail');
const { calculateBudgetPacing } = require('../dist/lib/budget');
const { BUDGET_LIMITS, MONTHLY_NET_INCOME } = require('../dist/index');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;

    if (!gmailUser || !gmailPass) {
      console.error("BUDGET_ERR: GMAIL_USER or GMAIL_APP_PASSWORD not set");
      process.exit(1);
    }

    const gmailTransactions = await scanGmailForDiscoverAlerts(gmailUser, gmailPass);
    const transactions = gmailTransactions.map(gmailToTransaction);
    const report = calculateBudgetPacing(transactions, BUDGET_LIMITS, MONTHLY_NET_INCOME);

    const date = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const memFile = path.join(
      process.env.HOME,
      '.openclaw/workspace/memory',
      `${new Date().toISOString().split('T')[0]}.md`
    );

    const entry = `\n## Budget Update — ${date}\n`;
    const stats = `- Spent: $${report.totalSpent.toFixed(0)} / $${report.totalBudget.toFixed(0)} | Rate: ${report.savingsRate.toFixed(1)}% | Status: ${report.status}\n`;
    const catSummary = report.categories.map(c =>
      `  - ${c.name}: $${c.spent.toFixed(0)} / $${c.limit.toFixed(0)} [${report.status}]`
    ).join('\n');

    const logEntry = `${entry}${stats}\n${catSummary}\n`;

    if (fs.existsSync(memFile)) {
      fs.appendFileSync(memFile, logEntry);
    }

    console.log(`Budget: $${report.totalSpent.toFixed(0)} / $${report.totalBudget.toFixed(0)} | Rate: ${report.savingsRate.toFixed(1)}% | ${report.status}`);
    console.log(`Logged to: ${memFile}`);
  } catch (e) {
    console.error('BUDGET_ERR:', e.message);
    process.exit(1);
  }
}

run();
