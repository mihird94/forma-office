import { FormaDocument } from '../../types/document';
import { uid } from '../spreadsheet/workbookOps';

export type DocTemplateId = 'blank' | 'spec' | 'meeting' | 'memo';

export interface DocTemplateMeta {
  id: DocTemplateId;
  name: string;
  subtitle: string;
}

export const DOC_TEMPLATES: DocTemplateMeta[] = [
  { id: 'blank', name: 'Blank Document', subtitle: 'Clean paginated canvas ready to write' },
  { id: 'spec', name: 'Technical Spec / RFC', subtitle: 'Architecture table, checklist & code block' },
  { id: 'meeting', name: 'Meeting Notes', subtitle: 'Agenda, decisions & action item checklist' },
  { id: 'memo', name: 'Executive Memo', subtitle: 'Structured one-pager with metrics table' },
];

export function createBlankDocument(title = 'Untitled Document'): FormaDocument {
  const now = Date.now();
  return {
    id: uid('doc'),
    title,
    html: '<p></p>',
    pageSettings: {
      pageSize: 'letter',
      margins: 'normal',
      fontFamily: 'Inter',
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function createSampleDocument(): FormaDocument {
  const now = Date.now();
  return {
    id: uid('doc'),
    title: 'Technical Spec — Open Format Architecture',
    pageSettings: {
      pageSize: 'letter',
      margins: 'normal',
      fontFamily: 'Inter',
    },
    createdAt: now,
    updatedAt: now,
    html: `
<h1>Forma Office — Open Format Architecture</h1>
<p><strong>Status:</strong> Production Ready &nbsp;|&nbsp; <strong>Standards:</strong> ISO/IEC 29500 (OOXML), ISO/IEC 26300 (ODF 1.2), RFC 4180, CommonMark/GFM</p>
<blockquote><p>Every spreadsheet and document authored in Forma Office round-trips cleanly with Microsoft Office, LibreOffice, Google Workspace, Apple iWork, and Git-based developer workflows — with zero proprietary lock-in.</p></blockquote>

<h2>1. Interoperability Matrix</h2>
<p>Below is the open-format coverage across <strong>Forma Sheets</strong> and <strong>Forma Docs</strong>:</p>
<table>
  <tbody>
    <tr>
      <th>Application</th>
      <th>Primary Open Standards</th>
      <th>Plain-Text / Web</th>
      <th>Compatible Ecosystems</th>
    </tr>
    <tr>
      <td><strong>Forma Sheets</strong></td>
      <td><code>.xlsx</code> (OOXML), <code>.ods</code> (ODF 1.2 + OpenFormula)</td>
      <td><code>.csv</code>, <code>.tsv</code></td>
      <td>Excel, LibreOffice Calc, Google Sheets, Numbers, Pandas</td>
    </tr>
    <tr>
      <td><strong>Forma Docs</strong></td>
      <td><code>.docx</code> (OOXML), <code>.odt</code> (ODF 1.2)</td>
      <td><code>.md</code> (GFM), <code>.html</code>, Print-to-PDF</td>
      <td>Word, LibreOffice Writer, Google Docs, Obsidian, GitHub</td>
    </tr>
  </tbody>
</table>

<h2>2. Key Capabilities</h2>
<ul>
  <li><strong>Spreadsheet Engine:</strong> 55+ Excel-compatible functions (<code>SUM</code>, <code>XLOOKUP</code>, <code>VLOOKUP</code>, <code>IFERROR</code>, <code>PMT</code>, <code>NPV</code>, <code>IRR</code>, cross-sheet formulas), cycle detection, fill-handle series &amp; relative reference shifting, live embedded charts.</li>
  <li><strong>Document Engine:</strong> Paginated WYSIWYG canvas built on ProseMirror/TipTap with live Table of Contents outline, tables, checklists, code blocks, find &amp; replace, and clean print-to-PDF.</li>
</ul>

<h2>3. Verification Checklist</h2>
<ul data-type="taskList">
  <li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked" /><span></span></label><div><p>Formula engine DAG &amp; cycle detection verified</p></div></li>
  <li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked" /><span></span></label><div><p>OOXML (<code>.xlsx</code> &amp; <code>.docx</code>) round-trip serialization validated</p></div></li>
  <li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked" /><span></span></label><div><p>OpenDocument (<code>.ods</code> &amp; <code>.odt</code>) ISO/IEC 26300 ZIP packaging verified</p></div></li>
</ul>

<h3>Example OpenFormula Mapping</h3>
<pre><code>Excel OOXML (.xlsx):   =SUM(Forecast!B5:E5)
ODF OpenFormula (.ods): of:=SUM([Forecast.B5:.E5])</code></pre>
`.trim(),
  };
}

function createMeetingNotesDoc(): FormaDocument {
  const now = Date.now();
  const dateStr = new Date(now).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return {
    id: uid('doc'),
    title: 'Meeting Notes',
    pageSettings: { pageSize: 'letter', margins: 'normal', fontFamily: 'Inter' },
    createdAt: now,
    updatedAt: now,
    html: `
<h1>Weekly Product Sync — ${dateStr}</h1>
<p><strong>Attendees:</strong> Team Lead, Engineering, Design &nbsp;|&nbsp; <strong>Facilitator:</strong> Owner</p>
<h2>Agenda</h2>
<ol>
  <li>Review sprint progress &amp; blockers</li>
  <li>Finalize Q4 release milestones</li>
  <li>Open questions &amp; next steps</li>
</ol>
<h2>Key Decisions</h2>
<blockquote><p>Summarize the primary decisions made in this meeting so stakeholders can scan in 30 seconds.</p></blockquote>
<h2>Action Items</h2>
<ul data-type="taskList">
  <li data-type="taskItem" data-checked="false"><label><input type="checkbox" /><span></span></label><div><p>Share updated forecast workbook (.xlsx)</p></div></li>
  <li data-type="taskItem" data-checked="false"><label><input type="checkbox" /><span></span></label><div><p>Circulate architecture sign-off doc (.docx)</p></div></li>
  <li data-type="taskItem" data-checked="false"><label><input type="checkbox" /><span></span></label><div><p>Schedule customer beta review</p></div></li>
</ul>
`.trim(),
  };
}

function createExecutiveMemoDoc(): FormaDocument {
  const now = Date.now();
  const dateStr = new Date(now).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return {
    id: uid('doc'),
    title: 'Executive Memo',
    pageSettings: { pageSize: 'letter', margins: 'normal', fontFamily: 'Merriweather' },
    createdAt: now,
    updatedAt: now,
    html: `
<h1>Executive Memo: Q4 Strategic Update</h1>
<p><strong>TO:</strong> Leadership Team<br /><strong>FROM:</strong> Product &amp; Engineering<br /><strong>DATE:</strong> ${dateStr}<br /><strong>SUBJECT:</strong> Key Results &amp; Recommended Next Investment</p>
<hr />
<h2>Executive Summary</h2>
<p>State the recommendation up front in 2–3 crisp sentences, followed by supporting evidence and tradeoffs.</p>
<h2>Key Metrics</h2>
<table>
  <tbody>
    <tr><th>Metric</th><th>Target</th><th>Actual</th><th>Status</th></tr>
    <tr><td>Monthly Active Users</td><td>25,000</td><td>28,400</td><td><strong>Ahead</strong></td></tr>
    <tr><td>Net Retention</td><td>115%</td><td>118%</td><td><strong>On Track</strong></td></tr>
    <tr><td>Operating Margin</td><td>25%</td><td>32.5%</td><td><strong>Ahead</strong></td></tr>
  </tbody>
</table>
<h2>Recommendation &amp; Tradeoffs</h2>
<ul>
  <li><strong>Recommended path:</strong> Prioritize open-standard interoperability and desktop performance.</li>
  <li><strong>Key tradeoff:</strong> Defers cloud real-time sync until local-first experience is airtight.</li>
</ul>
`.trim(),
  };
}

export function createDocumentFromTemplate(templateId: DocTemplateId): FormaDocument {
  switch (templateId) {
    case 'spec':
      return createSampleDocument();
    case 'meeting':
      return createMeetingNotesDoc();
    case 'memo':
      return createExecutiveMemoDoc();
    case 'blank':
    default:
      return createBlankDocument('Untitled Document');
  }
}
