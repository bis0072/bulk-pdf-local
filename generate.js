/**
 * ============================================================
 * GROUPED LOTTERY COUPON GENERATOR (Timeout Fixed)
 * ============================================================
 */

const { launch }  = require('puppeteer-core');
const fs          = require('fs');
const path        = require('path');
const QRCode      = require('qrcode');
const bwipjs      = require('bwip-js');

// ─── Configuration ───────────────────────────────────────────
const TEMPLATE_PATH = path.resolve(__dirname, 'template.html');
const DATA_PATH     = path.resolve(__dirname, 'lottery.json');
const OUTPUT_DIR    = path.resolve(__dirname, 'output');
const COUPON_W      = 700;
const COUPON_H      = 380;

// ─── Utility: Sanitize Filenames ─────────────────────────────
const sanitize = (str) => (str || 'UNKNOWN').replace(/[^a-z0-9]/gi, '_').toUpperCase();

// ─── Find Browser ────────────────────────────────────────────
function findBrowser() {
  const PF    = process.env.ProgramFiles            || 'C:\\Program Files';
  const PF86  = process.env['ProgramFiles(x86)']    || 'C:\\Program Files (x86)';
  const LOCAL = process.env.LOCALAPPDATA            || '';

  const candidates = [
    path.join(PF,    'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(PF86,  'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(PF,    'Microsoft', 'Application', 'msedge.exe'),
    path.join(PF86,  'Microsoft', 'Application', 'msedge.exe'),
    path.join(PF,    'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(PF86,  'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  return null;
}

// ─── HTML Builder ────────────────────────────────────────────
function buildHtml(template, coupon, qrCodeDataUrl, barcodeDataUrl) {
  const balls = (coupon.CouponSl || [])
    .map(n => `<div class="num-ball">${n}</div>`)
    .join('\n        ');
// Logic: Cycle colors based on the Name length (simple way to keep it consistent per person)
  const schemes = ['scheme-gold', 'scheme-blue', 'scheme-green', 'scheme-red'];
  const nameLen = (coupon.Name || '').length;
  const selectedScheme = schemes[nameLen % schemes.length];
  return template
    .replace(/\{\{ID\}\}/g,             coupon.UUID || '')
    .replace(/\{\{COLOR_SCHEME\}\}/g,   selectedScheme)
    .replace(/\{\{PRIZE\}\}/g,          coupon.Name)
    .replace(/\{\{NUMBER_BALLS\}\}/g,   balls)
    .replace(/\{\{SERIAL\}\}/g,         coupon.Agent)
    .replace(/\{\{BARCODE_IMG\}\}/g,    barcodeDataUrl)
    .replace(/\{\{BARCODE_VALUE\}\}/g,  coupon.couponNo)
    .replace(/\{\{QR_CODE\}\}/g,        qrCodeDataUrl);
}

// ─── Main Execution ──────────────────────────────────────────
(async () => {
  // 1. Setup
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  if (!fs.existsSync(DATA_PATH)) {
    console.error(`❌ Error: ${DATA_PATH} not found.`);
    process.exit(1);
  }

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  const allCoupons = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));

  // 2. Group Coupons by "Name_Agent"
  console.log('🔄 Grouping coupons by Name and Agent...');
  const groups = {};

  allCoupons.forEach(coupon => {
    const key = `${sanitize(coupon.Name)}__${sanitize(coupon.Agent)}`;
    if (!groups[key]) {
      groups[key] = { name: coupon.Name, agent: coupon.Agent, items: [] };
    }
    groups[key].items.push(coupon);
  });

  const groupKeys = Object.keys(groups);
  console.log(`📋 Found ${groupKeys.length} unique Name/Agent groups.`);

  // 3. Launch Browser
  const executablePath = findBrowser();
  if (!executablePath) {
    console.error('❌ Browser not found.');
    process.exit(1);
  }

  const browser = await launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  // Create a page and DISABLE TIMEOUTS
  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(0); // FIX: 0 means no timeout limit
  await page.setViewport({ width: COUPON_W, height: COUPON_H, deviceScaleFactor: 2 });

  // 4. Process Each Group
  for (const key of groupKeys) {
    const group = groups[key];
    const filename = `${sanitize(group.name)}_${sanitize(group.agent)}.pdf`;
    
    console.log(`\n📂 Processing Group: ${group.name} (Agent: ${group.agent})`);
    console.log(`   - ${group.items.length} coupons to render...`);

    const pdfBuffers = [];

    // Render coupons for this specific group
    for (const [idx, coupon] of group.items.entries()) {
      try {
        // Generate assets
        const qrString = ` Ag_Name: ${coupon.Name} | Agent: ${coupon.Agent} | Coupon: ${coupon.couponNo} | UUID: ${coupon.UUID}`;
        const qrUrl = await QRCode.toDataURL(qrString, { width: 100, margin: 0, color: { dark: '#FFF', light: '#0000' } });

        const barcodeBuf = await bwipjs.toBuffer({
          bcid: 'code128', text: coupon.couponNo, scale: 3, height: 10, includetext: false, backgroundcolor: 'ffffff', padding: 5
        });
        const barUrl = `data:image/png;base64,${barcodeBuf.toString('base64')}`;

        // Build HTML
        const html = buildHtml(template, coupon, qrUrl, barUrl);

        // Load Content (Optimization: 'load' is faster than 'networkidle0' for data URIs)
        await page.setContent(html, { waitUntil: 'load' });

        const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: COUPON_W, height: COUPON_H } });
        pdfBuffers.push(buf);
        
        // Optional: Progress log for large batches
        // if (idx % 10 === 0) console.log(`     ... rendered ${idx + 1}/${group.items.length}`);

      } catch (err) {
        console.error(`   ❌ Error on coupon ${coupon.couponNo}:`, err.message);
      }
    }

    // Generate PDF for this Group
    if (pdfBuffers.length > 0) {
      console.log(`   📄 Compiling PDF for ${group.name}...`);
      
      const pdfPage = await browser.newPage();
      await pdfPage.setDefaultNavigationTimeout(0); // Fix timeout for PDF generation too
      
      const pdfHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { margin: 0; padding: 40px; display: flex; flex-direction: column; align-items: center; background: #fff; }
            .wrapper { margin-bottom: 20px; break-inside: avoid; }
            img { width: ${COUPON_W}px; border: 1px dashed #ccc; }
          </style>
        </head>
        <body>
          ${pdfBuffers.map(b => `<div class="wrapper"><img src="data:image/png;base64,${b.toString('base64')}" /></div>`).join('')}
        </body>
        </html>`;

      await pdfPage.setContent(pdfHtml, { waitUntil: 'load' });
      
      const savePath = path.join(OUTPUT_DIR, filename);
      await pdfPage.pdf({
        path: savePath,
        format: 'A4',
        printBackground: true,
        margin: { top: '20px', bottom: '20px' }
      });

      console.log(`   ✅ Saved PDF: ${filename}`);
      await pdfPage.close();
    }
  }

  await browser.close();
  console.log('\n🎉 All groups processed successfully.');
})();