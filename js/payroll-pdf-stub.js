/* ============================================================================
   payroll-pdf-stub.js — workbook -> signed PDF step.

   Confirmed scope (per Coleby):
   - Only ONE PDF per timesheet — generated once the employee has submitted
     (their "signature"), the manager has approved (their "signature"), AND
     Accounting has finished processing. That's why the call site is
     markTimesheetComplete() in payroll-tools.js, not anywhere in the
     employee/manager steps.
   - Accounting doesn't sign the document — they're just the last step that
     has to finish before the signed PDF goes out.
   - Delivery is in-app only, no email. The finished PDF shows up in the
     employee's existing "My Documents" list on the Staff Finance page
     (reusing that already-built view/download flow instead of inventing a
     new one), plus an in-app notification to the employee and their
     approving manager.
   - Compensation math: flat rate for every hour (regular + OT), no 1.5x —
     confirmed explicitly, even though the source workbook's own formula
     uses 1.5x for OT. Flagging that mismatch here since it's a real
     discrepancy in the source file, in case that ever needs revisiting.

   Layout below is transcribed directly from the real workbook (Leeward
   Group - Time Sheet 2026.xlsx, sheet "Time Sheet") via openpyxl — exact
   cell refs, not guessed from the screenshot:
     B8:C8   Date (generated)          E9:F9   Pay Period Beginning (value)
     B9:C9   Employee Name             E11:F11 Pay Period Ending (value)
     B10:C10 Department
     Rows 13-26 (14 rows): A Date | B Time In | C Time Out | D Regular Hours
       | E OT Hours | F Total Hours
     Row 29: D Total Regular | E Total OT | F Total Hours (sums of above)
     C34 Hourly Rate | D34 Total Hours This Period | F34 Total compensation
     C36:G37 Employee signature area | C38:G39 Approved by area
   We don't try to reproduce the workbook's own mixed cell formatting/
   formulas (rows 13-19 and 20-26 are inconsistent even in the original —
   some daily rows have an auto 8hr/day OT-split formula, some don't). Since
   this is a final, already-computed document (not a live spreadsheet
   someone types into), every value below is computed once in JS from our
   own data and rendered as plain text/numbers.

   Rendering approach: since this app is static HTML/JS with no backend,
   there's no server-side Excel/PDF engine available. Instead this builds an
   HTML mock of the sheet (same layout/labels) and rasterizes it to a PDF
   with jsPDF + html2canvas (loaded via CDN in payroll-tools.html, the only
   page that calls this). Requires window.jspdf and window.html2canvas.
============================================================================ */

const PDF_STAFF_DOCUMENTS_BUCKET = 'staff-documents';

function pdfEscapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function pdfFormatDate(d) {
  if (!d) return '';
  return d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit', year: 'numeric' });
}

// Local copy of the same 14-day expansion timesheet.js uses, since this
// file is loaded on payroll-tools.html (no timesheet.js there).
function pdfDateRangeForPeriod(period) {
  const dates = [];
  let cur = ppParseDate(period.start_date);
  const end = ppParseDate(period.end_date);
  while (cur <= end) {
    const iso = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    dates.push(iso);
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  return dates;
}

function pdfFormatClockTime(t) {
  // timesheet_entries.clock_in/out come back as "HH:MM:SS" (Postgres time) —
  // render as a friendly 12-hour clock time, or blank if not set.
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  let h = Number(hStr);
  const m = mStr;
  const period = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${period}`;
}

/* ===========================
   HTML TEMPLATE (mirrors the real workbook's layout)
=========================== */

function buildTimesheetPdfHtml({ employeeName, department, generatedDate, periodStart, periodEnd, rows, totalRegular, totalOT, totalHours, hourlyRate, compensation, employeeSignedAt, managerName, managerSignedAt }) {

  const cellStyle = 'border:1px solid #999;padding:4px 6px;font-size:11px;';
  const labelStyle = 'font-weight:700;font-size:11px;color:#333;';
  const valueBoxStyle = 'border-bottom:1px solid #333;padding:4px 2px;font-size:12px;min-height:16px;';

  const rowsHtml = rows.map(r => `
    <tr>
      <td style="${cellStyle}">${pdfEscapeHtml(r.dateLabel)}</td>
      <td style="${cellStyle}">${pdfEscapeHtml(r.timeIn)}</td>
      <td style="${cellStyle}">${pdfEscapeHtml(r.timeOut)}</td>
      <td style="${cellStyle}text-align:right;">${r.regular.toFixed(2)}</td>
      <td style="${cellStyle}text-align:right;">${r.overtime.toFixed(2)}</td>
      <td style="${cellStyle}text-align:right;">${(r.regular + r.overtime).toFixed(2)}</td>
    </tr>
  `).join('');

  return `
    <div style="width:760px;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#111;background:#fff;">

      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #333;padding-bottom:10px;margin-bottom:14px;">
        <div>
          <div style="font-size:16px;font-weight:700;">The Leeward Group, LLC</div>
          <div style="font-size:11px;color:#444;">PO Box 3579 Wilmington, NC, 28406</div>
          <div style="font-size:11px;color:#444;">info@theleewardgroup.us &nbsp; 910-524-5130</div>
        </div>
        <div style="font-size:18px;font-weight:700;">Time Sheet</div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:14px;">
        <tr>
          <td style="width:50%;padding:4px 8px 4px 0;vertical-align:top;">
            <div style="${labelStyle}">Date</div>
            <div style="${valueBoxStyle}">${pdfEscapeHtml(generatedDate)}</div>
          </td>
          <td style="width:50%;padding:4px 0 4px 8px;vertical-align:top;">
            <div style="${labelStyle}">Pay Period Beginning</div>
            <div style="${valueBoxStyle}">${pdfEscapeHtml(periodStart)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:4px 8px 4px 0;vertical-align:top;">
            <div style="${labelStyle}">Employee Name</div>
            <div style="${valueBoxStyle}">${pdfEscapeHtml(employeeName)}</div>
          </td>
          <td style="padding:4px 0 4px 8px;vertical-align:top;">
            <div style="${labelStyle}">Pay Period Ending</div>
            <div style="${valueBoxStyle}">${pdfEscapeHtml(periodEnd)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:4px 8px 4px 0;vertical-align:top;">
            <div style="${labelStyle}">Department</div>
            <div style="${valueBoxStyle}">${pdfEscapeHtml(department || '—')}</div>
          </td>
          <td></td>
        </tr>
      </table>

      <table style="width:100%;border-collapse:collapse;margin-bottom:10px;">
        <thead>
          <tr>
            <th style="${cellStyle}background:#eee;text-align:left;">Date</th>
            <th style="${cellStyle}background:#eee;text-align:left;">Time In</th>
            <th style="${cellStyle}background:#eee;text-align:left;">Time Out</th>
            <th style="${cellStyle}background:#eee;text-align:right;">Regular Hours</th>
            <th style="${cellStyle}background:#eee;text-align:right;">OT Hours</th>
            <th style="${cellStyle}background:#eee;text-align:right;">Total Hours</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>

      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <tr>
          <td style="${cellStyle}font-weight:700;">Total for the Period</td>
          <td style="${cellStyle}text-align:right;font-weight:700;">Total Regular: ${totalRegular.toFixed(2)}</td>
          <td style="${cellStyle}text-align:right;font-weight:700;">Total OT: ${totalOT.toFixed(2)}</td>
          <td style="${cellStyle}text-align:right;font-weight:700;">Total Hours: ${totalHours.toFixed(2)}</td>
        </tr>
      </table>

      <div style="border:1px solid #999;padding:10px 12px;margin-bottom:20px;">
        <div style="font-weight:700;font-size:13px;margin-bottom:8px;">Time Sheet Summary</div>
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="${cellStyle}">Hourly Rate</td>
            <td style="${cellStyle}text-align:right;">$${hourlyRate.toFixed(2)}</td>
            <td style="${cellStyle}">Total Hours This Period</td>
            <td style="${cellStyle}text-align:right;">${totalHours.toFixed(2)}</td>
            <td style="${cellStyle}">Total compensation</td>
            <td style="${cellStyle}text-align:right;font-weight:700;">$${compensation.toFixed(2)}</td>
          </tr>
        </table>
        <div style="font-size:9px;color:#777;margin-top:4px;">Compensation calculated at a flat hourly rate for all hours (regular + overtime).</div>
      </div>

      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="width:30%;padding:6px 8px 6px 0;vertical-align:top;">
            <div style="${labelStyle}">Employee signature</div>
          </td>
          <td style="width:70%;padding:6px 0;vertical-align:top;">
            <div style="${valueBoxStyle}">${pdfEscapeHtml(employeeName)} — signed ${pdfEscapeHtml(employeeSignedAt)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:6px 8px 6px 0;vertical-align:top;">
            <div style="${labelStyle}">Approved by</div>
          </td>
          <td style="padding:6px 0;vertical-align:top;">
            <div style="${valueBoxStyle}">${managerName ? `${pdfEscapeHtml(managerName)} — approved ${pdfEscapeHtml(managerSignedAt)}` : '—'}</div>
          </td>
        </tr>
      </table>

    </div>
  `;
}

/* ===========================
   MAIN ENTRY POINT
=========================== */

async function generateFinalPdf(timesheetId) {

  if (!window.supabaseClient) { console.error('[payroll-pdf-stub] Supabase client not ready'); return null; }
  if (!window.jspdf || !window.html2canvas) {
    console.error('[payroll-pdf-stub] jsPDF/html2canvas not loaded — check the CDN <script> tags on this page.');
    return null;
  }

  // Idempotent: if a final PDF already exists for this timesheet, don't
  // generate a second one (there's only ever supposed to be one).
  const { data: existing, error: existingError } = await window.supabaseClient
    .from('pdf_history')
    .select('id, file_url')
    .eq('timesheet_id', timesheetId)
    .eq('kind', 'final')
    .maybeSingle();
  if (existingError) console.error('[payroll-pdf-stub] Failed checking for an existing PDF:', existingError);
  if (existing) {
    console.log('[payroll-pdf-stub] Final PDF already exists for this timesheet — skipping regeneration.');
    return existing.file_url;
  }

  // ---- Gather everything needed to fill the template ----

  const { data: timesheet, error: tsError } = await window.supabaseClient
    .from('timesheets')
    .select('*')
    .eq('id', timesheetId)
    .maybeSingle();
  if (tsError || !timesheet) { console.error('[payroll-pdf-stub] Failed to load timesheet:', tsError); return null; }

  const { data: payrollEmployee, error: peError } = await window.supabaseClient
    .from('payroll_employees')
    .select('*')
    .eq('id', timesheet.payroll_employee_id)
    .maybeSingle();
  if (peError || !payrollEmployee) { console.error('[payroll-pdf-stub] Failed to load payroll employee:', peError); return null; }

  const { data: period, error: periodError } = await window.supabaseClient
    .from('pay_periods')
    .select('*')
    .eq('id', timesheet.pay_period_id)
    .maybeSingle();
  if (periodError || !period) { console.error('[payroll-pdf-stub] Failed to load pay period:', periodError); return null; }

  // Reads go through staff_users_directory (a view that omits password_hash)
  // now that the base table's RLS no longer grants anon a direct SELECT —
  // see supabase-staff-users-rls-setup.sql. Only full_name/username/id are
  // used below, all of which the view still has.
  const { data: employeeStaff, error: empError } = await window.supabaseClient
    .from('staff_users_directory')
    .select('*')
    .eq('id', payrollEmployee.staff_id)
    .maybeSingle();
  if (empError || !employeeStaff) { console.error('[payroll-pdf-stub] Failed to load employee record:', empError); return null; }

  let managerStaff = null;
  if (timesheet.approved_by) {
    const { data: mgr, error: mgrError } = await window.supabaseClient
      .from('staff_users_directory')
      .select('*')
      .eq('id', timesheet.approved_by)
      .maybeSingle();
    if (mgrError) console.error('[payroll-pdf-stub] Failed to load approving manager:', mgrError);
    managerStaff = mgr || null;
  }

  const { data: entries, error: entriesError } = await window.supabaseClient
    .from('timesheet_entries')
    .select('*')
    .eq('timesheet_id', timesheetId);
  if (entriesError) console.error('[payroll-pdf-stub] Failed to load timesheet entries:', entriesError);

  const entriesByDate = {};
  (entries || []).forEach(e => { entriesByDate[e.work_date] = e; });

  // ---- Build the 14-day row set + totals ----

  const dates = pdfDateRangeForPeriod(period);
  const rows = dates.map(dateIso => {
    const entry = entriesByDate[dateIso] || {};
    const dayLabel = ppParseDate(dateIso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return {
      dateLabel: dayLabel,
      timeIn: pdfFormatClockTime(entry.clock_in),
      timeOut: pdfFormatClockTime(entry.clock_out),
      regular: Number(entry.regular_hours || 0),
      overtime: Number(entry.overtime_hours || 0)
    };
  });

  const totalRegular = rows.reduce((sum, r) => sum + r.regular, 0);
  const totalOT = rows.reduce((sum, r) => sum + r.overtime, 0);
  const totalHours = totalRegular + totalOT;
  const hourlyRate = Number(payrollEmployee.hourly_rate || 0);
  // Flat rate for every hour, confirmed — NOT 1.5x for OT, even though the
  // source workbook's own formula uses 1.5x (see file header note above).
  const compensation = hourlyRate * totalHours;

  const html = buildTimesheetPdfHtml({
    employeeName: employeeStaff.full_name || employeeStaff.username || 'Employee',
    department: payrollEmployee.department,
    generatedDate: pdfFormatDate(new Date()),
    periodStart: pdfFormatDate(ppParseDate(period.start_date)),
    periodEnd: pdfFormatDate(ppParseDate(period.end_date)),
    rows,
    totalRegular,
    totalOT,
    totalHours,
    hourlyRate,
    compensation,
    employeeSignedAt: timesheet.submitted_at ? pdfFormatDate(new Date(timesheet.submitted_at)) : '—',
    managerName: managerStaff ? (managerStaff.full_name || managerStaff.username) : null,
    managerSignedAt: timesheet.approved_at ? pdfFormatDate(new Date(timesheet.approved_at)) : '—'
  });

  // ---- Render HTML -> PDF (off-screen container, removed when done) ----

  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-10000px';
  container.style.top = '0';
  container.innerHTML = html;
  document.body.appendChild(container);

  let pdfBlob;
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });

    await new Promise((resolve, reject) => {
      doc.html(container, {
        callback: () => resolve(),
        x: 20,
        y: 20,
        width: 570, // letter page width (612pt) minus margins
        windowWidth: 800,
        html2canvas: { scale: 0.75 }
      });
      // Fallback in case the callback never fires for some reason.
      setTimeout(() => reject(new Error('PDF rendering timed out')), 20000);
    });

    pdfBlob = doc.output('blob');
  } catch (renderError) {
    console.error('[payroll-pdf-stub] Failed to render PDF:', renderError);
    document.body.removeChild(container);
    return null;
  }

  document.body.removeChild(container);

  // ---- Upload + record + notify ----

  const periodLabel = `${period.start_date}_to_${period.end_date}`;
  const fileName = `Timesheet-${periodLabel}.pdf`;
  const filePath = `${employeeStaff.id}/${crypto.randomUUID()}-${fileName}`;

  const { error: uploadError } = await window.supabaseClient
    .storage
    .from(PDF_STAFF_DOCUMENTS_BUCKET)
    .upload(filePath, pdfBlob, { contentType: 'application/pdf' });
  if (uploadError) { console.error('[payroll-pdf-stub] Failed to upload PDF:', uploadError); return null; }

  const { error: docError } = await window.supabaseClient
    .from('staff_documents')
    .insert({
      user_id: employeeStaff.id,
      file_name: fileName,
      file_path: filePath,
      category: 'timesheet'
    });
  if (docError) console.error('[payroll-pdf-stub] Failed to record staff_documents row:', docError);

  const { error: historyError } = await window.supabaseClient
    .from('pdf_history')
    .insert({ timesheet_id: timesheetId, kind: 'final', file_url: filePath });
  if (historyError) console.error('[payroll-pdf-stub] Failed to record pdf_history row:', historyError);

  await window.supabaseClient.from('notifications').insert({
    user_id: employeeStaff.id,
    title: 'Timesheet PDF ready',
    message: `Your signed timesheet for ${period.start_date} to ${period.end_date} is ready — check My Documents on Staff Finance.`,
    type: 'timesheet'
  });

  if (managerStaff) {
    await window.supabaseClient.from('notifications').insert({
      user_id: managerStaff.id,
      title: 'Timesheet PDF ready',
      message: `The signed timesheet you approved for ${employeeStaff.full_name || employeeStaff.username} (${period.start_date} to ${period.end_date}) has been finalized.`,
      type: 'timesheet'
    });
  }

  return filePath;
}

/* ===========================
   INVALIDATE (Accounting "Unapprove")
   Called from payroll-tools.js's unapproveTimesheet() before it resets the
   timesheet's status. If a final PDF was already generated (i.e. this
   timesheet had reached Complete), that PDF reflected numbers that are
   about to change once the employee fixes and resubmits — so it gets torn
   down here: the storage file, its staff_documents row (removes it from the
   employee's My Documents list), and the pdf_history row. That also clears
   the way for generateFinalPdf()'s own idempotency check to allow a fresh
   PDF once this timesheet reaches Complete again.
=========================== */

async function invalidateFinalPdf(timesheetId) {
  if (!window.supabaseClient) { console.error('[payroll-pdf-stub] Supabase client not ready'); return; }

  const { data: pdfRow, error } = await window.supabaseClient
    .from('pdf_history')
    .select('id, file_url')
    .eq('timesheet_id', timesheetId)
    .eq('kind', 'final')
    .maybeSingle();
  if (error) { console.error('[payroll-pdf-stub] Failed checking for an existing PDF to invalidate:', error); return; }
  if (!pdfRow) return; // nothing generated yet — nothing to clean up

  if (pdfRow.file_url) {
    const { error: removeError } = await window.supabaseClient
      .storage
      .from(PDF_STAFF_DOCUMENTS_BUCKET)
      .remove([pdfRow.file_url]);
    if (removeError) console.warn('[payroll-pdf-stub] Could not remove old PDF file from storage:', removeError);

    const { error: docDeleteError } = await window.supabaseClient
      .from('staff_documents')
      .delete()
      .eq('file_path', pdfRow.file_url);
    if (docDeleteError) console.warn('[payroll-pdf-stub] Could not remove old staff_documents row:', docDeleteError);
  }

  const { error: historyDeleteError } = await window.supabaseClient
    .from('pdf_history')
    .delete()
    .eq('id', pdfRow.id);
  if (historyDeleteError) console.error('[payroll-pdf-stub] Could not remove old pdf_history row:', historyDeleteError);
}
