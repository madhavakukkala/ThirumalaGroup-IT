/**
 * HP Ledger screen: renders the real page over an in-memory database (made-up loan only),
 * opens the account, takes a payment and checks what the screen shows. "Today" is fixed at 12 Nov 2026.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as any }));

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('./helpers/fakeSupabase');
  fake.db = createFakeSupabase();
  return {
    supabase: fake.db.client, rawSupabase: fake.db.client, default: fake.db.client,
    resolveSchemaAndTable: (t: string) => ({ schema: 'finance', table: t }), supabaseHelpers: {}
  };
});
vi.mock('../utils/dateUtils', async () => {
  const actual: any = await vi.importActual('../utils/dateUtils');
  return { ...actual, getLocalBusinessDateISO: (d?: Date) => (d ? actual.getLocalBusinessDateISO(d) : '2026-11-12') };
});
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { username: 'TESTER', is_admin: true, features: [] } })
}));
vi.mock('../components/finance/FinanceSmartCalendar', () => ({
  FinanceSmartCalendar: ({ label, value, onChange }: any) => (
    <input aria-label={label} value={value} onChange={e => onChange(e.target.value)} />
  )
}));
vi.mock('../components/finance/FinancePrintPreview', () => ({ default: () => null }));

import HPLedger from '../pages/finance/HPLedger';
import { supabaseFinance } from '../lib/supabaseFinance';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const settle = async (ms = 30) => {
  await act(async () => { await new Promise(r => setTimeout(r, ms)); });
};
const waitFor = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 60; i++) {
    if (check()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for: ${label}\n${container.textContent?.slice(0, 600)}`);
};
const text = () => container.textContent || '';
const buttonWith = (t: string) => Array.from(container.querySelectorAll('button')).find(b => (b.textContent || '').includes(t)) as HTMLButtonElement;
const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('HP Ledger screen', () => {
  beforeEach(async () => {
    fake.db.seed({
      finance_customers: [{ id: 'cust-1', name: 'TEST CUSTOMER', phone: '9000000000' }],
      finance_loans: [], finance_transactions: [], finance_cd_ledger_entries: [], finance_dues: [],
      finance_transaction_reviews: [], finance_edited_logs: []
    });
    // 1,00,000; 10 installments every 30 days; 3% + 0.75% per period; doc 1,000; loan date 1 Sep 2026
    const loan = await supabaseFinance.createLoan({
      loan_id: 'HP001', customer_id: 'cust-1', date: '2026-09-01', amount: 100000, interest_rate: 3,
      duration_months: 10, period_days: 30, due_type: 'Daily', due_amount: 13000, penalty_percent: 0.75,
      document_charges: 1000, remarks: 'test', loan_category: 'HP'
    } as any, { id: 'cust-1' }, [], [], [], 'TESTER');
    // installment 2 (due 1 Oct) paid on time
    const r = await supabaseFinance.postHPReceipt({ loanId: loan!.id, kind: 'payment', date: '2026-10-01', amount: 13000, receiptNo: 'RC1', userName: 'TESTER' });
    expect(r.success).toBe(true);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(<HPLedger />); });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('lists the account: 2 of 10 paid, principal 80,000, installment 3 is 12 days late', async () => {
    await waitFor(() => text().includes('HP001'), 'account row');
    expect(text()).toContain('2 / 10');
    expect(text()).toContain('80,000.00');
    // installment 3 due 31 Oct 2026, 12 days late on 12 Nov: 13,000 + 156 late interest + 39 penalty
    expect(text()).toContain('13,195.00');
    expect(text()).toContain('12 days late');
  });

  it('opens the account, shows the position and saves a payment with the right split', async () => {
    await waitFor(() => text().includes('HP001'), 'account row');
    await act(async () => { buttonWith('Open').click(); });
    await waitFor(() => text().includes('HP Account: HP001'), 'drawer');

    expect(text()).toContain('Installments Paid2 of 10');
    // Total for Close on 12 Nov: 80,000 + 3,000 (installment 3) + 12 days of installment 4 (1,200) + 195 late
    expect(text()).toContain('84,395.00');
    expect(text()).toContain('Oldest unpaid installment is 12 days late');

    const amount = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    await typeInto(amount, '13195');
    await waitFor(() => text().includes('Payment split'), 'split preview');
    expect(text()).toContain('Penalty (HP Penalty)39.00');
    expect(text()).toContain('Late interest (HP Interest)156.00');
    expect(text()).toContain('Interest (HP Interest)3,000.00');
    expect(text()).toContain('Principal10,000.00');

    await act(async () => { buttonWith('Save Payment').click(); });
    await waitFor(() => fake.db.tables.finance_transactions.some((t: any) => t.amount === 13195), 'receipt saved');
    const saved = fake.db.tables.finance_transactions.find((t: any) => t.amount === 13195);
    expect(saved.remarks).toMatch(/^HP Collection - RC\d+ \(Prin: 10000\.00, Interest: 3156\.00, Pen: 39\.00\)$/);
    await waitFor(() => text().includes('Installments Paid3 of 10'), 'position refreshed');
  });

  it('refuses an amount that would pay off the loan and points to Close Account', async () => {
    await waitFor(() => text().includes('HP001'), 'account row');
    await act(async () => { buttonWith('Open').click(); });
    await waitFor(() => text().includes('HP Account: HP001'), 'drawer');
    const amount = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    await typeInto(amount, '83300');
    await waitFor(() => text().includes('Use Close Account'), 'refusal');
    expect(buttonWith('Save Payment').disabled).toBe(true);
  });
});
