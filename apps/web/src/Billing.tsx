import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Invoice, type InvoiceDetail, type PreviewResult } from './api';

// The operator's money board: what was earned in a period, what has been invoiced, and what
// the clinic still owes. An invoice is the one document in this product that somebody outside
// the company reads and adds up by hand, so the panel shows the arithmetic plainly — the sum
// of the lines above it, the tariff that priced each row, and the night premium when it
// applied. A draft can be dropped; an issued invoice cannot be changed, only corrected by a
// later amendment, which is the design on purpose.

function formatRupees(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

export function Billing({ tenantId }: { tenantId: number }) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selected, setSelected] = useState<InvoiceDetail | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [balance, setBalance] = useState<{ balancePaise: number; balanceRupees: string } | null>(null);
  const [topupAmount, setTopupAmount] = useState('');
  const [topupRef, setTopupRef] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.invoices(tenantId);
      setInvoices(res.invoices);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    }
  }, [tenantId]);

  const loadBalance = useCallback(async () => {
    try {
      const res = await api.billingBalance(tenantId);
      setBalance({ balancePaise: res.balancePaise, balanceRupees: res.balanceRupees });
    } catch {
      // The invoice list already reports server failure; a missing balance is not a second banner.
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
    void loadBalance();
  }, [load, loadBalance]);

  async function viewInvoice(id: number) {
    try {
      const res = await api.invoice(id);
      setSelected({ invoice: res.invoice, lines: res.lines });
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    }
  }

  async function previewPeriod() {
    if (!periodStart || !periodEnd) return;
    setBusy(null);
    try {
      const res = await api.previewBilling(tenantId, periodStart, periodEnd);
      setPreview(res);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    }
  }

  async function createInvoice() {
    if (!periodStart || !periodEnd) return;
    setBusy(1);
    setError(null);
    try {
      const res = await api.createInvoice(tenantId, periodStart, periodEnd);
      await load();
      setSelected({ invoice: res.invoice, lines: res.lines });
      setPreview(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    } finally {
      setBusy(null);
    }
  }

  async function issueInvoice(id: number) {
    setBusy(id);
    setError(null);
    try {
      await api.issueInvoice(id);
      await load();
      if (selected?.invoice.id === id) {
        const res = await api.invoice(id);
        setSelected({ invoice: res.invoice, lines: res.lines });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    } finally {
      setBusy(null);
    }
  }

  async function deleteInvoice(id: number) {
    setBusy(id);
    setError(null);
    try {
      await api.deleteInvoice(id);
      await load();
      if (selected?.invoice.id === id) setSelected(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2>Billing</h2>
      {error && <div className="error">{error}</div>}

      {balance && (
        <div className="billing-preview" style={{ marginBottom: 12 }}>
          <h3 className="sub">Prepaid balance</h3>
          <div style={{ fontSize: '1.2em', fontWeight: 'bold' }}>
            {formatRupees(balance.balancePaise)}
          </div>
          <div className="billing-period" style={{ marginTop: 8 }}>
            <input type="number" min="1" step="1" placeholder="amount in ₹"
              value={topupAmount} onChange={(e) => setTopupAmount(e.target.value)} style={{ width: 100 }} />
            <input placeholder="UPI ref (optional)" value={topupRef}
              onChange={(e) => setTopupRef(e.target.value)} style={{ width: 140 }} />
            <button className="primary" disabled={!topupAmount || Number(topupAmount) <= 0}
              onClick={async () => {
                try {
                  await api.billingTopup(tenantId, Number(topupAmount), 'upi', topupRef.trim() || undefined);
                  await loadBalance();
                  setTopupAmount('');
                  setTopupRef('');
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : 'top-up failed');
                }
              }}>Top up</button>
          </div>
        </div>
      )}

      <div className="billing-preview">
        <h3 className="sub">Preview a period</h3>
        <div className="billing-period">
          <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} placeholder="from" />
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} placeholder="to" />
          <button onClick={() => void previewPeriod()}>Preview</button>
          <button className="primary" disabled={busy !== null || !periodStart || !periodEnd} onClick={() => void createInvoice()}>
            {busy === 1 ? 'Creating' : 'Create draft'}
          </button>
        </div>
      </div>

      {preview && (
        <div className="billing-preview-result">
          <h3 className="sub">
            Preview: {preview.lines.length} line{preview.lines.length === 1 ? '' : 's'}
            {preview.unpriced.length > 0 && ` · ${preview.unpriced.length} unpriced`}
          </h3>
          <table>
            <thead>
              <tr><th>Description</th><th>Tariff</th><th>Qty</th><th>Unit</th><th>Amount</th></tr>
            </thead>
            <tbody>
              {preview.lines.map((line) => (
                <tr key={line.studyId}>
                  <td>{line.description}</td>
                  <td>{line.tariffCode ?? <span className="state amber">unpriced</span>}</td>
                  <td>{line.quantity}</td>
                  <td>{formatRupees(line.unitPaise)}{line.night && <span className="sub"> night</span>}</td>
                  <td>{formatRupees(line.amountPaise)}</td>
                </tr>
              ))}
              {preview.unpriced.map((u) => (
                <tr key={u.studyId} className="unpriced">
                  <td colSpan={4}>study {u.studyId}: {u.reason}</td>
                  <td>—</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}><strong>Total</strong></td>
                <td><strong>{formatRupees(preview.totals.totalPaise)}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <h3 className="sub">Invoices</h3>
      {invoices.length === 0 && !error && <div className="sub">No invoices yet.</div>}
      <table>
        <thead>
          <tr><th>Number</th><th>Period</th><th>Lines</th><th>Total</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id} className={selected?.invoice.id === inv.id ? 'selected' : undefined}>
              <td><button className="link" onClick={() => void viewInvoice(inv.id)}>{inv.number}</button></td>
              <td>{new Date(inv.periodStart).toLocaleDateString()} – {new Date(inv.periodEnd).toLocaleDateString()}</td>
              <td>{inv.lineCount}</td>
              <td>{inv.totalRupees}</td>
              <td>
                <span className={`state ${inv.status === 'issued' ? 'green' : 'amber'}`}>{inv.status}</span>
                {inv.issuedAt && <span className="sub"> · {new Date(inv.issuedAt).toLocaleDateString()}</span>}
              </td>
              <td>
                {inv.status === 'draft' && (
                  <span className="acts">
                    <button className="primary" disabled={busy !== null} onClick={() => void issueInvoice(inv.id)}>
                      {busy === inv.id ? 'Issuing' : 'Issue'}
                    </button>
                    <button disabled={busy !== null} onClick={() => void deleteInvoice(inv.id)}>
                      {busy === inv.id ? 'Dropping' : 'Drop'}
                    </button>
                  </span>
                )}
                {inv.status === 'issued' && (
                  <a className="link" href={api.invoiceCsvHref(inv.id)}>CSV</a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && (
        <div className="billing-detail">
          <h3 className="sub">
            Invoice {selected.invoice.number}
            <span className={`state ${selected.invoice.status === 'issued' ? 'green' : 'amber'}`}>
              {' '}{selected.invoice.status}
            </span>
          </h3>
          <table>
            <thead>
              <tr><th>Description</th><th>Tariff</th><th>Qty</th><th>Unit</th><th>Amount</th></tr>
            </thead>
            <tbody>
              {selected.lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.description}</td>
                  <td>{line.tariffCode ?? <span className="state amber">unpriced</span>}</td>
                  <td>{line.quantity}</td>
                  <td>{formatRupees(line.unitPaise)}{line.night && <span className="sub"> night</span>}</td>
                  <td>{formatRupees(line.amountPaise)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Gross</td>
                <td colSpan={2}>{formatRupees(selected.invoice.grossPaise)}</td>
              </tr>
              <tr>
                <td colSpan={3}>Tax</td>
                <td colSpan={2}>{formatRupees(selected.invoice.taxPaise)}</td>
              </tr>
              <tr>
                <td colSpan={3}><strong>Total</strong></td>
                <td colSpan={2}><strong>{selected.invoice.totalRupees}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
