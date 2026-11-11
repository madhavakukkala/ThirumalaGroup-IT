import React, { useEffect, useMemo, useState } from 'react';
import Card from '../../components/UI/Card';
import Input from '../../components/UI/Input';
import Button from '../../components/UI/Button';
import { FinanceSmartCalendar } from '../../components/finance/FinanceSmartCalendar';
import { supabaseFinance } from '../../lib/supabaseFinance';
import { supabase } from '../../lib/supabase';
import { Printer, X, Eye, ShieldAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import FinancePrintPreview from '../../components/finance/FinancePrintPreview';
import { getLocalBusinessDateISO } from '../../utils/dateUtils';
import { useAuth } from '../../contexts/AuthContext';
import {
  buildHPContract, computeHPPosition, previewHPPayment, hpPaymentsFromTransactions, hpOpening,
  isHPOpeningRow, hpRound, HPPosition, HPPaymentKind, HP_CLOSE_PREFIX, HP_NPA_PREFIX
} from '../../services/hpLedgerEngine';

/**
 * HP Ledger: hire purchase accounts. Every amount comes from the HP engine (hpLedgerEngine.ts),
 * following the rules in the "HP Ledger Knowledge Base". Receipts cannot be edited here.
 */

const fmt = (n: number) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (s?: string | null) => (s ? String(s).split('T')[0].split('-').reverse().join('/') : '—');

type Tab = 'statement' | 'interest' | 'payment' | 'editHistory';

interface HPRow {
  id: string;
  loanId: string;
  customerName: string;
  phone: string;
  date: string;
  amount: number;
  status: string;
  periodDays: number;
  installments: number;
  position: HPPosition;
  txs: any[];
  rawLoan: any;
}

const statusChip = (status: string) => {
  const s = status.toUpperCase();
  if (s === 'ACTIVE') return 'bg-green-100 text-green-800';
  if (s.includes('NPA')) return 'bg-orange-100 text-orange-800';
  return 'bg-gray-100 text-gray-800';
};

const instChip: Record<string, string> = {
  'Paid': 'bg-green-100 text-green-700',
  'Part paid': 'bg-amber-100 text-amber-700',
  'Overdue': 'bg-rose-100 text-rose-700',
  'Due today': 'bg-blue-100 text-blue-700',
  'Upcoming': 'bg-gray-100 text-gray-500',
};

const HPLedger: React.FC = () => {
  const { user } = useAuth();
  const today = getLocalBusinessDateISO();

  const [rows, setRows] = useState<HPRow[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [showPrintPreview, setShowPrintPreview] = useState(false);
  const [pendingReviews, setPendingReviews] = useState<any[]>([]);

  // Account drawer
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('statement');
  const [paymentDate, setPaymentDate] = useState<string>(today);
  const [amountText, setAmountText] = useState('');
  const [kind, setKind] = useState<HPPaymentKind>('payment');
  const [receiptNo, setReceiptNo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editLogs, setEditLogs] = useState<any[]>([]);

  // NPA close
  const [showNpaModal, setShowNpaModal] = useState(false);
  const [npaReason, setNpaReason] = useState('');
  const [npaSettlementAmount, setNpaSettlementAmount] = useState('');
  const [isNpaClosing, setIsNpaClosing] = useState(false);

  const fetchLedgerData = async () => {
    setLoading(true);
    try {
      const [loans, txs, pending] = await Promise.all([
        supabaseFinance.getLoans(),
        supabaseFinance.getTransactions(),
        supabaseFinance.getTransactionReviews({ status: 'PENDING' })
      ]);
      setPendingReviews(pending || []);

      const hpLoans = (loans || []).filter((l: any) =>
        String(l.loan_category || '').toUpperCase() === 'HP' || String(l.loan_id || '').toUpperCase().startsWith('HP')
      );

      const built: HPRow[] = [];
      for (const loan of hpLoans as any[]) {
        const loanTxs = (txs || []).filter((t: any) => t.loan_id === loan.id);
        try {
          const contract = buildHPContract(loan);
          const position = computeHPPosition(contract, hpPaymentsFromTransactions(loanTxs), today);
          built.push({
            id: loan.id,
            loanId: loan.loan_id,
            customerName: loan.customer?.name || 'N/A',
            phone: loan.customer?.phone || loan.customer?.phone_1 || '',
            date: String(loan.date || '').split('T')[0],
            amount: Number(loan.amount) || 0,
            status: loan.status || 'Active',
            periodDays: contract.periodDays,
            installments: contract.installments,
            position,
            txs: loanTxs,
            rawLoan: loan
          });
        } catch (e) {
          console.error('HP loan could not be worked out:', loan.loan_id, e);
        }
      }
      setRows(built);
    } catch (err) {
      console.error(err);
      toast.error('Failed to load the HP Ledger');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLedgerData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredRows = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return rows.filter(r =>
      (r.loanId.toLowerCase().includes(q) || r.customerName.toLowerCase().includes(q) || (r.phone && r.phone.includes(q))) &&
      (!startDate || r.date >= startDate) &&
      (!endDate || r.date <= endDate)
    );
  }, [rows, searchQuery, startDate, endDate]);

  const selected = rows.find(r => r.id === selectedId) || null;
  const isActive = !!selected && String(selected.status).toUpperCase() === 'ACTIVE';
  const payments = useMemo(() => (selected ? hpPaymentsFromTransactions(selected.txs) : []), [selected]);

  // Position on the chosen payment date (so the screen shows what is due that day)
  const drawerPos = useMemo(() => {
    if (!selected) return null;
    try {
      return computeHPPosition(selected.rawLoan, payments, paymentDate || today);
    } catch {
      return selected.position;
    }
  }, [selected, payments, paymentDate, today]);

  const amountNum = hpRound(Number(amountText) || 0);
  const preview = useMemo(() => {
    if (!selected || !isActive || !(amountNum > 0)) return null;
    return previewHPPayment(selected.rawLoan, payments, { date: paymentDate, amount: amountNum, kind });
  }, [selected, isActive, payments, paymentDate, amountNum, kind]);

  const openLoan = async (row: HPRow) => {
    setSelectedId(row.id);
    setTab('statement');
    setPaymentDate(today);
    setAmountText('');
    setKind('payment');
    setEditLogs([]);
    try {
      setReceiptNo(await supabaseFinance.getNextReceiptNumber());
    } catch {
      setReceiptNo('');
      toast.error('Could not get the next receipt number');
    }
  };

  useEffect(() => {
    if (!selectedId || tab !== 'editHistory') return;
    supabase
      .from('finance_edited_logs')
      .select('*')
      .eq('record_id', selectedId)
      .order('edited_at', { ascending: false })
      .then(({ data }: any) => setEditLogs(data || []));
  }, [selectedId, tab]);

  const fillDue = () => {
    if (!drawerPos) return;
    setKind('payment');
    setAmountText(drawerPos.totalDue > 0 ? drawerPos.totalDue.toFixed(2) : '');
  };
  const fillClose = () => {
    if (!drawerPos) return;
    setKind('close');
    setAmountText(drawerPos.totalForClose.toFixed(2));
  };

  const submitReceipt = async () => {
    if (!selected || !preview) return;
    if (!preview.ok) {
      toast.error(preview.error);
      return;
    }
    if (!receiptNo) {
      toast.error('Receipt number is missing');
      return;
    }
    const finalKind = preview.after.splits[preview.after.splits.length - 1].kind;
    if (finalKind === 'close' && !window.confirm(`Close ${selected.loanId} with ${fmt(amountNum)} (Total for Close)? Future interest is waived.`)) return;

    setSubmitting(true);
    try {
      const res = await supabaseFinance.postHPReceipt({
        loanId: selected.id,
        kind: finalKind,
        date: paymentDate,
        amount: amountNum,
        receiptNo,
        userName: user?.username || 'Staff'
      });
      if (!res.success) {
        toast.error(res.error || 'Failed to save the receipt');
        return;
      }
      toast.success(res.closed ? `${selected.loanId} closed. Receipt ${receiptNo}` : `Receipt ${receiptNo} saved`);
      setAmountText('');
      setKind('payment');
      await fetchLedgerData();
      try {
        setReceiptNo(await supabaseFinance.getNextReceiptNumber());
      } catch {
        setReceiptNo('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleNPACloseSubmit = async () => {
    if (!selected || !drawerPos) return;
    setIsNpaClosing(true);
    try {
      const closedBy = user?.username || 'Staff';
      const closedAt = new Date(paymentDate).toISOString();
      const settlement = hpRound(Number(npaSettlementAmount) || 0);
      const reason = npaReason.trim().toUpperCase();
      const npaReceiptNo = await supabaseFinance.getNextReceiptNumber();

      const { error: loanError } = await supabase.from('finance_loans')
        .update({
          status: 'NPA_CLOSED',
          npa_closed: true,
          remarks: `${selected.rawLoan.remarks || ''}\n[NPA CLOSED AT ${closedAt} BY ${closedBy} WITH SETTLEMENT AMOUNT: ${settlement}]`.trim().toUpperCase()
        })
        .eq('id', selected.id);
      if (loanError) throw loanError;

      const totalLiability = drawerPos.totalForClose;
      await supabaseFinance.addNPARecord({
        loan_id: selected.id,
        customer_id: selected.rawLoan.customer_id,
        customer_name: selected.customerName.toUpperCase(),
        phone: selected.phone || '',
        loan_type: 'HP',
        loan_amount: selected.amount,
        paid_amount: hpRound(drawerPos.principalPaid + drawerPos.interestPaid + drawerPos.lateInterestPaid + drawerPos.penaltyPaid),
        balance_amount: drawerPos.principalBalance,
        interest_due: hpRound(drawerPos.interestDue + drawerPos.currentPeriodInterest + drawerPos.lateInterestDue),
        penalty_due: drawerPos.penaltyDue,
        settlement_amount: settlement,
        total_liability: totalLiability,
        waived_amount: hpRound(Math.max(0, totalLiability - settlement)),
        reason,
        closed_by: closedBy,
        closed_at: closedAt
      } as any);

      if (settlement > 0) {
        await supabaseFinance.addTransaction({
          loan_id: selected.id,
          type: 'Collection',
          amount: settlement,
          date: paymentDate,
          remarks: `${HP_NPA_PREFIX} Settlement Collection - ${npaReceiptNo} (Prin: ${settlement.toFixed(2)})`,
          collected_by: closedBy,
          receipt_no: npaReceiptNo
        } as any);
      }

      const waived = hpRound(Math.max(0, totalLiability - settlement));
      if (waived > 0) {
        await supabaseFinance.addWaiverAudit({
          loan_id: selected.id,
          waived_date: paymentDate,
          waived_by: closedBy,
          waiver_reason: `NPA CLOSE WRITE-OFF: ${reason}`,
          waived_interest: hpRound(drawerPos.interestDue + drawerPos.currentPeriodInterest + drawerPos.lateInterestDue),
          waived_penalty: drawerPos.penaltyDue,
          waived_commission: 0,
          receipt_no: npaReceiptNo
        } as any);
      }

      await fetchLedgerData();
      toast.success('HP account closed under NPA');
      setShowNpaModal(false);
      setSelectedId(null);
    } catch (e: any) {
      console.error(e);
      toast.error('Error closing the HP account under NPA');
    } finally {
      setIsNpaClosing(false);
    }
  };

  const isPending = (tx: any) =>
    !!tx.receipt_no && tx.receipt_no !== '-' && pendingReviews.some(r => r.receipt_number === tx.receipt_no && r.loan_id === selected?.id);

  const txLabel = (tx: any) => {
    if (tx.type === 'Disbursement') return 'Loan given';
    if (isHPOpeningRow(tx)) return 'Kept at disbursement';
    const rem = String(tx.remarks || '').trim();
    if (rem.startsWith(HP_CLOSE_PREFIX)) return 'Close';
    if (rem.startsWith(HP_NPA_PREFIX)) return 'NPA settlement';
    return 'Payment';
  };

  const sortedTxs = selected
    ? [...selected.txs].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.created_at || '').localeCompare(String(b.created_at || '')))
    : [];

  const tabBtn = (t: Tab, label: string) => (
    <button
      key={t}
      onClick={() => setTab(t)}
      className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide ${tab === t ? 'bg-white text-indigo-800 shadow-sm border' : 'text-slate-700 hover:text-black'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-7xl mx-auto print:p-0">
      {/* Header */}
      <div className="flex justify-between items-center border-b border-indigo-100 pb-4">
        <div>
          <h1 className="finance-h1 text-indigo-900">HP Ledger</h1>
          <p className="finance-small-label uppercase">Hire Purchase Account Book</p>
        </div>
        <Button onClick={() => setShowPrintPreview(true)} variant="primary" size="sm" icon={Printer}>
          Print Ledger
        </Button>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl bg-slate-50 p-4 rounded-xl border">
        <Input label="Filter HP Accounts" value={searchQuery} onChange={setSearchQuery} placeholder="Search by ID, Name, Phone..." />
        <FinanceSmartCalendar label="From Date" value={startDate} onChange={setStartDate} module="HP_LEDGER" />
        <FinanceSmartCalendar label="To Date" value={endDate} onChange={setEndDate} module="HP_LEDGER" />
      </div>

      {/* Accounts */}
      <div className={showPrintPreview || selected ? 'hidden' : 'block'}>
        <Card title="HP Ledger Accounts" className="shadow-md">
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-indigo-600"></div>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="text-center py-8 text-slate-400 font-bold uppercase">No HP accounts found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-xs sm:text-sm">
                <thead>
                  <tr className="bg-slate-50 text-left">
                    <th className="px-3 py-2 finance-small-label uppercase">Loan No</th>
                    <th className="px-3 py-2 finance-small-label uppercase">Customer</th>
                    <th className="px-3 py-2 finance-small-label uppercase">Loan Date</th>
                    <th className="px-3 py-2 text-right finance-small-label uppercase">Loan Amount</th>
                    <th className="px-3 py-2 text-center finance-small-label uppercase">Installments</th>
                    <th className="px-3 py-2 finance-small-label uppercase">Next Due</th>
                    <th className="px-3 py-2 text-right finance-small-label uppercase">Principal Balance</th>
                    <th className="px-3 py-2 text-right finance-small-label uppercase">Due Today</th>
                    <th className="px-3 py-2 text-center finance-small-label uppercase">Status</th>
                    <th className="px-3 py-2 text-center finance-small-label uppercase">Open</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredRows.map(row => {
                    const p = row.position;
                    const active = String(row.status).toUpperCase() === 'ACTIVE';
                    return (
                      <tr key={row.id} className="hover:bg-slate-50/50">
                        <td className="px-3 py-2 text-indigo-900 font-mono font-semibold">{row.loanId}</td>
                        <td className="px-3 py-2">
                          <div className="text-gray-950 font-medium">{row.customerName}</div>
                          {row.phone && <div className="text-gray-400 text-xs">{row.phone}</div>}
                        </td>
                        <td className="px-3 py-2 text-gray-500">{dmy(row.date)}</td>
                        <td className="px-3 py-2 text-right">{fmt(row.amount)}</td>
                        <td className="px-3 py-2 text-center text-gray-700">
                          {p.installmentsPaid} / {p.installmentsTotal}
                          <div className="text-[10px] text-gray-400">every {row.periodDays} days</div>
                        </td>
                        <td className="px-3 py-2 text-gray-700">
                          {active && p.nextDue ? (<>{dmy(p.nextDue.dueDate)}<div className="text-[10px] text-gray-400">{fmt(p.nextDue.balance)}</div></>) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right text-rose-800 font-semibold">{fmt(p.principalBalance)}</td>
                        <td className="px-3 py-2 text-right">
                          {active && p.totalDue > 0 ? (
                            <>
                              <span className="font-semibold text-gray-900">{fmt(p.totalDue)}</span>
                              {p.dueDays > 0 && <div className={`text-[10px] font-bold ${p.isNPA ? 'text-orange-700' : 'text-rose-600'}`}>{p.dueDays} days late{p.isNPA ? ' · NPA' : ''}</div>}
                            </>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${statusChip(row.status)}`}>{row.status}</span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button onClick={() => openLoan(row)} className="inline-flex items-center text-indigo-600 hover:text-indigo-800 hover:underline text-xs font-semibold gap-1">
                            <Eye className="w-4 h-4" /> Open
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Account drawer */}
      {selected && drawerPos && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-gray-900/40 backdrop-blur-sm flex justify-end">
          <div className="w-full max-w-5xl bg-white shadow-2xl h-full flex flex-col">
            <div className="px-4 sm:px-6 py-4 bg-gradient-to-r from-indigo-900 to-slate-900 text-white flex justify-between items-center gap-3">
              <div className="min-w-0">
                <h2 className="text-lg sm:text-xl font-bold truncate">HP Account: {selected.loanId}</h2>
                <p className="text-indigo-200 text-xs uppercase tracking-wider truncate">
                  {selected.customerName} · {fmt(selected.amount)} · {selected.installments} installments every {selected.periodDays} days · {drawerPos.contract.interestRate}% + {drawerPos.contract.penaltyRate}% per period
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isActive && (
                  <Button
                    onClick={() => { setNpaReason(''); setNpaSettlementAmount(''); setShowNpaModal(true); }}
                    variant="danger" size="sm" icon={ShieldAlert}
                    className="bg-orange-600 hover:bg-orange-700 text-white border-0 rounded-xl text-xs py-1.5 px-3 font-bold"
                  >
                    NPA Close
                  </Button>
                )}
                <button onClick={() => setSelectedId(null)} className="p-1 rounded-full hover:bg-indigo-800/50 text-white" aria-label="Close">
                  <X className="w-6 h-6" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
              {/* Position */}
              <div className="text-[11px] text-slate-500 font-semibold uppercase">As on {dmy(drawerPos.asOf)}</div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                {[
                  ['Loan Amount', fmt(selected.amount), 'text-gray-900'],
                  ['Principal Balance', fmt(drawerPos.principalBalance), 'text-rose-800'],
                  ['Total Due', fmt(drawerPos.totalDue), 'text-gray-900'],
                  ['Late Interest + Penalty Due', `${fmt(drawerPos.lateInterestDue)} + ${fmt(drawerPos.penaltyDue)}`, 'text-red-700'],
                  ['Installments Paid', `${drawerPos.installmentsPaid} of ${drawerPos.installmentsTotal}`, 'text-slate-700'],
                  ['Total for Close', drawerPos.status === 'Closed' ? '—' : fmt(drawerPos.totalForClose), 'text-indigo-800'],
                ].map(([label, value, cls]) => (
                  <div key={label} className="bg-slate-50 border p-3 rounded-xl">
                    <div className="text-gray-400 text-[10px] uppercase font-semibold leading-tight">{label}</div>
                    <div className={`text-sm sm:text-base font-bold mt-1 ${cls}`}>{value}</div>
                  </div>
                ))}
              </div>
              {drawerPos.dueDays > 0 && isActive && (
                <div className={`text-xs font-semibold rounded-lg px-3 py-2 ${drawerPos.isNPA ? 'bg-orange-50 text-orange-800 border border-orange-200' : 'bg-rose-50 text-rose-700 border border-rose-100'}`}>
                  Oldest unpaid installment is {drawerPos.dueDays} days late (due {dmy(drawerPos.oldestUnpaidDueDate)}).{drawerPos.isNPA ? ' This account is NPA (more than 90 days).' : ''}
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
                {/* Tabs */}
                <div className="lg:col-span-3 space-y-3 min-w-0">
                  <div className="flex flex-wrap gap-1 bg-slate-100 p-1 rounded-xl">
                    {tabBtn('statement', 'Ledger Statement')}
                    {tabBtn('interest', 'Interest History')}
                    {tabBtn('payment', 'Payment History')}
                    {tabBtn('editHistory', 'Edit History')}
                  </div>

                  {tab === 'statement' && (
                    <div className="border rounded-xl overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-100 text-xs">
                        <thead className="bg-slate-50">
                          <tr className="text-gray-500">
                            <th className="px-2 py-2 text-left">No</th>
                            <th className="px-2 py-2 text-left">Due Date</th>
                            <th className="px-2 py-2 text-right">Amount</th>
                            <th className="px-2 py-2 text-right">Paid</th>
                            <th className="px-2 py-2 text-right">Balance</th>
                            <th className="px-2 py-2 text-right">Days Late</th>
                            <th className="px-2 py-2 text-right">Late Int.</th>
                            <th className="px-2 py-2 text-right">Penalty</th>
                            <th className="px-2 py-2 text-center">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 bg-white">
                          {drawerPos.installments.map(i => (
                            <tr key={i.no} className="hover:bg-slate-50">
                              <td className="px-2 py-1.5 font-mono text-gray-600">#{i.no}</td>
                              <td className="px-2 py-1.5 text-gray-600 whitespace-nowrap">{dmy(i.dueDate)}</td>
                              <td className="px-2 py-1.5 text-right" title={`Principal ${fmt(i.principal)} + interest ${fmt(i.interest)}`}>{fmt(i.amount)}</td>
                              <td className="px-2 py-1.5 text-right text-green-700">{fmt(i.paid)}</td>
                              <td className="px-2 py-1.5 text-right text-rose-700">{i.balance > 0 ? fmt(i.balance) : '—'}</td>
                              <td className="px-2 py-1.5 text-right">{i.daysLate > 0 ? i.daysLate : '—'}</td>
                              <td className="px-2 py-1.5 text-right text-red-600">{i.lateInterest > 0 ? fmt(i.lateInterest) : '—'}</td>
                              <td className="px-2 py-1.5 text-right text-red-600">{i.penalty > 0 ? fmt(i.penalty) : '—'}</td>
                              <td className="px-2 py-1.5 text-center">
                                <span className={`inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-bold ${instChip[i.status] || ''}`}>
                                  {i.no === 1 ? 'Kept at disbursement' : i.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {tab === 'interest' && (
                    <div className="border rounded-xl overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-100 text-xs">
                        <thead className="bg-slate-50">
                          <tr className="text-gray-500">
                            <th className="px-2 py-2 text-left">Date</th>
                            <th className="px-2 py-2 text-left">Receipt</th>
                            <th className="px-2 py-2 text-left">Installments</th>
                            <th className="px-2 py-2 text-right">Interest</th>
                            <th className="px-2 py-2 text-right">Late Interest</th>
                            <th className="px-2 py-2 text-right">Penalty</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 bg-white">
                          {drawerPos.splits.length === 0 ? (
                            <tr><td colSpan={6} className="text-center py-6 text-gray-400">No receipts yet.</td></tr>
                          ) : drawerPos.splits.map((s, idx) => (
                            <tr key={s.id || idx}>
                              <td className="px-2 py-1.5 whitespace-nowrap">{dmy(s.date)}</td>
                              <td className="px-2 py-1.5 font-mono text-indigo-800">{s.receiptNo || '—'}{s.kind === 'close' ? ' (close)' : ''}</td>
                              <td className="px-2 py-1.5 text-gray-600">{s.installments.map(n => `#${n}`).join(', ') || '—'}</td>
                              <td className="px-2 py-1.5 text-right">{fmt(s.interest)}</td>
                              <td className="px-2 py-1.5 text-right text-red-600">{fmt(s.lateInterest)}</td>
                              <td className="px-2 py-1.5 text-right text-red-600">{fmt(s.penalty)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-slate-50 font-bold">
                          <tr>
                            <td colSpan={3} className="px-2 py-2 text-right">Total</td>
                            <td className="px-2 py-2 text-right">{fmt(drawerPos.interestPaid)}</td>
                            <td className="px-2 py-2 text-right">{fmt(drawerPos.lateInterestPaid)}</td>
                            <td className="px-2 py-2 text-right">{fmt(drawerPos.penaltyPaid)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}

                  {tab === 'payment' && (
                    <div className="border rounded-xl overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-100 text-xs">
                        <thead className="bg-slate-50">
                          <tr className="text-gray-500">
                            <th className="px-2 py-2 text-left">Date</th>
                            <th className="px-2 py-2 text-left">Receipt</th>
                            <th className="px-2 py-2 text-left">Type</th>
                            <th className="px-2 py-2 text-left">By</th>
                            <th className="px-2 py-2 text-right">Amount</th>
                            <th className="px-2 py-2 text-right">Principal</th>
                            <th className="px-2 py-2 text-right">Interest</th>
                            <th className="px-2 py-2 text-right">Penalty</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 bg-white">
                          {sortedTxs.map(tx => {
                            const split = drawerPos.splits.find(s => s.id === tx.id);
                            const opening = isHPOpeningRow(tx) ? hpOpening(drawerPos.contract) : null;
                            const pending = isPending(tx);
                            return (
                              <tr key={tx.id} className={pending ? 'bg-[#fff7ed]' : ''}>
                                <td className="px-2 py-1.5 whitespace-nowrap">{dmy(tx.date)}</td>
                                <td className="px-2 py-1.5 font-mono text-indigo-800">
                                  {tx.receipt_no || '—'}
                                  {pending && <span className="ml-1 px-1 rounded text-[8px] font-bold bg-orange-50 text-orange-700 border border-orange-200 uppercase">Pending approval</span>}
                                </td>
                                <td className="px-2 py-1.5">{txLabel(tx)}</td>
                                <td className="px-2 py-1.5 text-gray-600">{tx.collected_by || '—'}</td>
                                <td className={`px-2 py-1.5 text-right font-semibold ${tx.type === 'Disbursement' ? 'text-rose-700' : 'text-gray-900'}`}>{fmt(Number(tx.amount))}</td>
                                <td className="px-2 py-1.5 text-right">{split ? fmt(split.principal) : opening ? fmt(opening.installment1Principal) : '—'}</td>
                                <td className="px-2 py-1.5 text-right">{split ? fmt(split.interest + split.lateInterest) : '—'}</td>
                                <td className="px-2 py-1.5 text-right">{split ? fmt(split.penalty) : opening && opening.docCharges > 0 ? `Doc ${fmt(opening.docCharges)}` : '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {tab === 'editHistory' && (
                    <div className="border rounded-xl overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-100 text-xs">
                        <thead className="bg-slate-50">
                          <tr className="text-gray-500">
                            <th className="px-2 py-2 text-left">Edited At</th>
                            <th className="px-2 py-2 text-left">By</th>
                            <th className="px-2 py-2 text-left">What Changed</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 bg-white">
                          {editLogs.length === 0 ? (
                            <tr><td colSpan={3} className="text-center py-6 text-gray-400">No edits recorded.</td></tr>
                          ) : editLogs.map((log: any, idx: number) => {
                            const oldV = log.old_values || {};
                            const newV = log.new_values || {};
                            const keys = Object.keys(newV).filter(k => k !== 'updated_at' && JSON.stringify(oldV[k]) !== JSON.stringify(newV[k]));
                            return (
                              <tr key={log.id || idx}>
                                <td className="px-2 py-1.5 whitespace-nowrap">{log.edited_at ? new Date(log.edited_at).toLocaleString('en-IN') : '—'}</td>
                                <td className="px-2 py-1.5">{log.edited_by || '—'}</td>
                                <td className="px-2 py-1.5 text-gray-700">
                                  {keys.length === 0 ? (log.table_name || '—') : keys.slice(0, 8).map(k => (
                                    <div key={k}><span className="font-semibold">{k}</span>: {String(oldV[k] ?? '—')} → {String(newV[k] ?? '—')}</div>
                                  ))}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Receive payment */}
                <div className="lg:col-span-2 bg-slate-50 p-4 border rounded-2xl space-y-3 h-fit">
                  <h3 className="text-sm font-bold text-gray-900 border-b pb-1 flex justify-between">
                    <span>Receive Payment</span>
                    <span className="text-xs text-gray-500 font-mono">RNo: {receiptNo || '—'}</span>
                  </h3>

                  {!isActive ? (
                    <p className="text-xs text-gray-500">This account is {selected.status}. No more receipts can be taken.</p>
                  ) : (
                    <>
                      <FinanceSmartCalendar label="Payment Date" value={paymentDate} onChange={setPaymentDate} module="HP_LEDGER" />
                      <Input
                        label={kind === 'close' ? 'Amount (Total for Close)' : 'Amount Received'}
                        type="number"
                        value={amountText}
                        onChange={(v: string) => { setAmountText(v); if (kind === 'close') setKind('payment'); }}
                        placeholder="0.00"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={fillDue} disabled={!(drawerPos.totalDue > 0)} className="text-[11px] font-semibold px-2 py-1 rounded-lg border bg-white hover:bg-slate-100 disabled:opacity-40">
                          Due: {fmt(drawerPos.totalDue)}
                        </button>
                        <button type="button" onClick={fillClose} className="text-[11px] font-semibold px-2 py-1 rounded-lg border bg-white hover:bg-slate-100">
                          Close Account: {fmt(drawerPos.totalForClose)}
                        </button>
                      </div>

                      {preview && !preview.ok && (
                        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-2 py-1.5">{preview.error}</div>
                      )}
                      {preview && preview.ok && (
                        <div className="bg-indigo-50 p-2.5 rounded-xl border border-indigo-100 text-[11px] text-indigo-900 space-y-1">
                          <div className="font-bold uppercase text-[10px] border-b border-indigo-100 pb-0.5 mb-1">
                            {preview.after.splits[preview.after.splits.length - 1].kind === 'close' ? 'Close split (future interest waived)' : 'Payment split'}
                          </div>
                          <div className="flex justify-between"><span>Penalty (HP Penalty)</span><span className="font-semibold">{fmt(preview.split.penalty)}</span></div>
                          <div className="flex justify-between"><span>Late interest (HP Interest)</span><span className="font-semibold">{fmt(preview.split.lateInterest)}</span></div>
                          <div className="flex justify-between"><span>Interest (HP Interest)</span><span className="font-semibold">{fmt(preview.split.interest)}</span></div>
                          <div className="flex justify-between"><span>Principal</span><span className="font-semibold">{fmt(preview.split.principal)}</span></div>
                          <div className="flex justify-between border-t border-indigo-100 pt-1"><span>Installments</span><span className="font-semibold">{preview.split.installments.map(n => `#${n}`).join(', ') || '—'}</span></div>
                        </div>
                      )}

                      <Button
                        onClick={submitReceipt}
                        variant="primary"
                        className="w-full py-2 text-sm font-semibold rounded-xl bg-indigo-800 hover:bg-indigo-900 text-white"
                        disabled={submitting || !preview || !preview.ok || !receiptNo}
                      >
                        {submitting ? 'Saving...' : preview && preview.ok && preview.after.splits[preview.after.splits.length - 1].kind === 'close'
                          ? `Close Account (${fmt(amountNum)})`
                          : `Save Payment${amountNum > 0 ? ` (${fmt(amountNum)})` : ''}`}
                      </Button>
                      <p className="text-[10px] text-gray-500 leading-snug">
                        Receipts cannot be edited here. Changes go through Finance Edit Entry with approval.
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Print */}
      <FinancePrintPreview isOpen={showPrintPreview} onClose={() => setShowPrintPreview(false)} title="HP Ledger" documentTitle="HP LEDGER REPORT">
        {filteredRows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-xs">
              <thead>
                <tr className="bg-gray-100 text-left">
                  <th className="px-2 py-2 uppercase">Loan No</th>
                  <th className="px-2 py-2 uppercase">Customer</th>
                  <th className="px-2 py-2 uppercase">Loan Date</th>
                  <th className="px-2 py-2 text-right uppercase">Loan Amount</th>
                  <th className="px-2 py-2 text-center uppercase">Installments</th>
                  <th className="px-2 py-2 text-right uppercase">Principal Balance</th>
                  <th className="px-2 py-2 text-right uppercase">Due Today</th>
                  <th className="px-2 py-2 text-right uppercase">Days Late</th>
                  <th className="px-2 py-2 text-center uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredRows.map(row => (
                  <tr key={row.id}>
                    <td className="px-2 py-2 font-mono">{row.loanId}</td>
                    <td className="px-2 py-2">{row.customerName}</td>
                    <td className="px-2 py-2">{dmy(row.date)}</td>
                    <td className="px-2 py-2 text-right">{fmt(row.amount)}</td>
                    <td className="px-2 py-2 text-center">{row.position.installmentsPaid} / {row.position.installmentsTotal}</td>
                    <td className="px-2 py-2 text-right">{fmt(row.position.principalBalance)}</td>
                    <td className="px-2 py-2 text-right">{fmt(row.position.totalDue)}</td>
                    <td className="px-2 py-2 text-right">{row.position.dueDays || '—'}</td>
                    <td className="px-2 py-2 text-center">{row.status}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 border-t-2 border-gray-200 font-bold">
                <tr>
                  <td colSpan={3} className="px-2 py-2 text-right uppercase">Total:</td>
                  <td className="px-2 py-2 text-right">{fmt(filteredRows.reduce((s, r) => s + r.amount, 0))}</td>
                  <td></td>
                  <td className="px-2 py-2 text-right">{fmt(filteredRows.reduce((s, r) => s + r.position.principalBalance, 0))}</td>
                  <td className="px-2 py-2 text-right">{fmt(filteredRows.reduce((s, r) => s + r.position.totalDue, 0))}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </FinancePrintPreview>

      {/* NPA close */}
      {showNpaModal && selected && drawerPos && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 w-full max-w-lg shadow-xl relative text-left">
            <button onClick={() => setShowNpaModal(false)} className="absolute right-4 top-4 text-gray-400 hover:text-gray-600" aria-label="Close">
              <X className="w-5 h-5" />
            </button>
            <h2 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
              <ShieldAlert className="w-6 h-6 text-orange-600" />
              NPA Settlement Close (HP)
            </h2>
            <div className="space-y-4">
              <div className="p-4 bg-orange-50 border border-orange-200 rounded-2xl text-xs leading-normal text-orange-900">
                <p className="font-semibold mb-1">Close {selected.loanId} under NPA on {dmy(paymentDate)}?</p>
                <p>Amount owed today (Total for Close): {fmt(drawerPos.totalForClose)}. Whatever is not collected is written off.</p>
              </div>
              <Input label="Settlement Amount Collected" type="number" value={npaSettlementAmount} onChange={setNpaSettlementAmount} placeholder="Enter settlement amount collected" required />
              <Input label="Reason / Remarks" value={npaReason} onChange={(v: string) => setNpaReason(v.toUpperCase())} placeholder="Enter reason for NPA closure" required />
              <div className="pt-2 flex gap-3">
                <Button onClick={() => setShowNpaModal(false)} variant="secondary" className="flex-1 rounded-xl">Cancel</Button>
                <Button onClick={handleNPACloseSubmit} variant="danger" className="flex-1 bg-orange-600 hover:bg-orange-700 text-white rounded-xl" disabled={isNpaClosing || !npaReason.trim()}>
                  {isNpaClosing ? 'Processing...' : 'Close NPA Account'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HPLedger;
