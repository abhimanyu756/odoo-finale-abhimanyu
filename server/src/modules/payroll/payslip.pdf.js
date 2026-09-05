import PDFDocument from 'pdfkit';

const INR = (v) =>
  `INR ${Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const day = (d) =>
  new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });

const PLUM = '#714B67';
const INK = '#1f2937';
const SOFT = '#6b7280';

// Renders one payslip. Returns a Buffer so the same bytes can be streamed to a
// browser download and attached to an email without regenerating.
export function renderPayslipPdf(slip) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 45 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { width } = doc.page;
    const left = 45;
    const right = width - 45;
    const inner = right - left;

    // Header band
    doc.rect(0, 0, width, 84).fill(PLUM);
    doc.fillColor('#fff').fontSize(18).font('Helvetica-Bold')
      .text('PeoplePay360', left, 26);
    doc.fontSize(9).font('Helvetica')
      .text(slip.employee?.company?.name ?? 'OxP Pvt Ltd', left, 50);
    doc.fontSize(14).font('Helvetica-Bold')
      .text('PAYSLIP', left, 26, { width: inner, align: 'right' });
    doc.fontSize(9).font('Helvetica')
      .text(slip.number, left, 48, { width: inner, align: 'right' })
      .text(`${day(slip.periodStart)} — ${day(slip.periodEnd)}`, left, 61, { width: inner, align: 'right' });

    doc.fillColor(INK);
    let y = 104;

    // Employee / period facts, two columns
    const facts = [
      ['Employee', `${slip.employee.firstName} ${slip.employee.lastName}`],
      ['Employee ID', slip.employee.identificationNo ?? '—'],
      ['Department', slip.employee.department?.name ?? '—'],
      ['Job Position', slip.employee.jobPosition?.name ?? '—'],
      ['Contract', slip.contract?.reference ?? '—'],
      ['Salary Structure', slip.payrun?.structure?.name ?? '—'],
      ['Worked Days', String(slip.workedDays)],
      ['Leave Days', String(slip.leaveDays)],
      ['Bank Account', slip.employee.bankAccount ?? 'Not provided'],
      ['Status', slip.status],
    ];

    doc.fontSize(8.5);
    facts.forEach(([label, value], i) => {
      const col = i % 2;
      const x = left + col * (inner / 2);
      if (col === 0 && i > 0) y += 17;
      doc.fillColor(SOFT).font('Helvetica').text(`${label}`, x, y, { width: inner / 2 - 10 });
      doc.fillColor(INK).font('Helvetica-Bold')
        .text(String(value), x + 88, y, { width: inner / 2 - 98 });
    });

    y += 30;
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#dee2e6').stroke();
    y += 14;

    // Salary computation table
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
      .text('Salary Computation', left, y);
    y += 18;

    const cols = { code: left, name: left + 60, cat: left + 250, amt: right - 90 };
    doc.rect(left, y - 4, inner, 18).fill('#f3f0f2');
    doc.fillColor(SOFT).fontSize(7.5).font('Helvetica-Bold');
    doc.text('CODE', cols.code + 4, y);
    doc.text('DESCRIPTION', cols.name, y);
    doc.text('CATEGORY', cols.cat, y);
    doc.text('AMOUNT', cols.amt, y, { width: 86, align: 'right' });
    y += 18;

    doc.fontSize(8.5).font('Helvetica');
    for (const line of slip.lines ?? []) {
      if (y > doc.page.height - 130) {
        doc.addPage();
        y = 50;
      }
      const isTotal = line.category === 'GROSS' || line.category === 'NET';
      const negative = line.category === 'DEDUCTION' && Number(line.amount) > 0;

      if (isTotal) {
        doc.rect(left, y - 3, inner, 16).fill('#faf8f9');
        doc.font('Helvetica-Bold');
      } else {
        doc.font('Helvetica');
      }

      doc.fillColor(SOFT).fontSize(7.5).text(line.code, cols.code + 4, y + 1);
      doc.fillColor(INK).fontSize(8.5).text(line.name, cols.name, y);
      doc.fillColor(SOFT).fontSize(7.5)
        .text(line.category.charAt(0) + line.category.slice(1).toLowerCase(), cols.cat, y + 1);
      doc.fillColor(negative ? '#b91c1c' : INK).fontSize(8.5)
        .text(`${negative ? '-' : ''}${INR(line.amount)}`, cols.amt, y, { width: 86, align: 'right' });

      y += 16;
      doc.moveTo(left, y - 2).lineTo(right, y - 2).strokeColor('#f1f1f1').stroke();
    }

    y += 10;

    // Net pay callout
    doc.rect(left, y, inner, 34).fill(PLUM);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(10)
      .text('NET SALARY PAYABLE', left + 12, y + 12);
    doc.fontSize(13)
      .text(INR(slip.net), left, y + 9, { width: inner - 12, align: 'right' });

    y += 48;
    doc.fillColor(SOFT).font('Helvetica').fontSize(7)
      .text(
        'This is a system-generated payslip and does not require a signature. '
        + `Generated on ${day(new Date())}.`,
        left, y, { width: inner, align: 'center' },
      );

    doc.end();
  });
}
