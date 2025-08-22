// popup.js — Looker Studio parity + UX automations (2025-08-21)
// Matches the provided formulas/screenshots and wires automatic updates.
//
// Key behaviors
// - Orientation Type dropdown: Billable / Non Billable (default Non Billable @ 16.5/hr)
// - Sick Pay Hours auto-fills from Hours section: Contract Regular Hours / 30
// - When Pay to Candidate (W-2 hourly) changes, auto-sets OT (1.5x) and recomputes
// - Additional Pay hourlies auto-calc from one-time inputs and W-2/sick hours
// - GROSS MARGINS and WEEKLY BREAKDOWN match Looker Studio logic
//
// Expected element IDs in HTML (inputs):
//   client, bill_regular, bill_ot, pay_regular, pay_ot, hrs_regular, hrs_ot, contract_len,
//   house_daily, meals_daily, orient_type, orient_hours, orient_pay,
//   bonus_start, bonus_complete, bcg_reimb, sick_hours, schedule_days, auto_sick_calc
// Expected element IDs in HTML (outputs/text placeholders):
//   afterfee_regular, afterfee_ot,
//   np_tax_hourly, np_tax_daily, np_tax_weekly, np_tax_monthly,
//   np_nt_hourly, np_nt_daily, np_nt_weekly, np_nt_monthly,
//   np_total_hourly, np_total_daily, np_total_weekly, np_total_monthly,
//   gm_hourly, gm_weekly, gm_monthly, gm_contract,
//   bill_weekly, bill_monthly, bill_contract,
//   pkg_total_hourly, pkg_w2, pkg_w2_ot, pkg_stipend_hourly, pkg_ot_special,
//   pkg_weekly_gross, pkg_weekly_w2, pkg_weekly_stipend,
//   orient_total, orient_hourly,
//   hourly_start, hourly_complete, hourly_bcg, hourly_sick,
//   gaugeArc, gaugeValue, title, fee, reset
//
// NOTE: If some IDs are missing in HTML, those specific outputs will be skipped gracefully.

const CLIENT_FEES: { [key: string]: number } = {
  "SimpliFI": 0.06,
  "Careerstaff": 0.035,
  "Medical Solutions": 0.042,
  "AMN": 0.05,
  "HWL": 0.045,
  "Eisenhower Health": 0.038,
  "Focus One": 0.04,
  "Priority Group": 0.039,
  "Intermountain Health": 0.041,
  "AYA": 0.048,
  "NYCHH": 0.055,
  "Medefis": 0.043
};

const BURDEN = 1.23;           // Employer burden multiplier for W-2 and specified items
const WEEKS_IN_MONTH = 4;      // Per Looker Studio
const DEFAULT_SCHEDULE_DAYS = 5;

const el = (id: string): Element | null => document.getElementById(id);
const fmtUSD = (v: number) =>
  (isFinite(v) ? v : 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

function valNum(id: string, fallback = 0): number {
  const n = el(id) as HTMLInputElement;
  if (!n) return fallback;
  const v = parseFloat(n.value);
  return isFinite(v) ? v : fallback;
}
function setText(id: string, text: string) { const n = el(id); if (n) n.textContent = text; }
function setValue(id: string, value: string | number) {
  const n = el(id) as HTMLInputElement;
  if (n) n.value = String(value);
}

function ensureClientSelector() {
  const clientSel = el("client") as HTMLSelectElement;
  if (!clientSel) return;
  if (clientSel.options.length === 0) {
    Object.keys(CLIENT_FEES).forEach(c => {
      const o = document.createElement("option"); o.value = c; o.textContent = c; clientSel.appendChild(o);
    });
  }
  if (!clientSel.value) clientSel.value = "SimpliFI";
  const feeTxt = el("fee");
  if (feeTxt) feeTxt.textContent = "Fee: " + (CLIENT_FEES[clientSel.value]).toLocaleString("en-US", {style:"percent", minimumFractionDigits:2});
  const ttl = el("title"); if (ttl) ttl.textContent = clientSel.value + " Rate Calculator";
  clientSel.addEventListener("change", () => {
    if (feeTxt) feeTxt.textContent = "Fee: " + (CLIENT_FEES[clientSel.value]).toLocaleString("en-US", {style:"percent", minimumFractionDigits:2});
    if (ttl) ttl.textContent = clientSel.value + " Rate Calculator";
    recalc();
  });
}

function ensureOrientationControls() {
  const orientSel = el("orient_type") as HTMLSelectElement;
  if (!orientSel) return;
  if (orientSel.options.length === 0) {
    ["Billable","Non Billable"].forEach(v => {
      const o = document.createElement("option"); o.value = o.textContent = v; orientSel.appendChild(o);
    });
  }
  orientSel.value = "Non Billable"; // Set default value
  const orientPay = el("orient_pay") as HTMLInputElement;
  if (orientSel.value === "Non Billable" && orientPay && (!orientPay.value || parseFloat(orientPay.value) === 0)) {
    orientPay.value = "16.5";
  }
  orientSel.addEventListener("change", () => {
    const orientPayInput = el("orient_pay") as HTMLInputElement;
    if (orientSel.value === "Non Billable" && orientPayInput) {
        orientPayInput.value = "16.5";
    }
    recalc();
  });
}

function ensureReset() {
  const resetBtn = el("reset");
  if (!resetBtn) return;
  resetBtn.addEventListener("click", () => {
    document.querySelectorAll("input[type=number]").forEach(i => {
      (i as HTMLInputElement).value = '';
    });
    const clientSel = el("client") as HTMLSelectElement; if (clientSel) clientSel.value = "SimpliFI";
    const orientSel = el("orient_type") as HTMLSelectElement; if (orientSel) orientSel.value = "Non Billable";
    const orientPay = el("orient_pay") as HTMLInputElement; if (orientPay) orientPay.value = "16.5";
    const scheduleDays = el("schedule_days") as HTMLInputElement; if(scheduleDays) scheduleDays.value = "5";
    const sickBox = el("auto_sick_calc") as HTMLInputElement; if (sickBox) sickBox.checked = true;
    recalc();
  });
}

function wireAutoSick() {
  const sickBox = el("auto_sick_calc") as HTMLInputElement;
  if (sickBox) {
    if (typeof sickBox.checked === "boolean" && sickBox.checked === false) {
      // leave as-is; user can toggle
    } else {
      sickBox.checked = true;
    }
    sickBox.addEventListener("change", recalc);
  }
}

function wirePayToCandidate() {
  const w2 = el("pay_regular") as HTMLInputElement;
  if (!w2) return;
  const ot = el("pay_ot") as HTMLInputElement;
  const sync = () => { if (ot) {
      const w2Value = parseFloat(w2.value || "0");
      ot.value = w2Value > 0 ? (w2Value * 1.5 || 0).toFixed(2) : '';
    }
  };
  w2.addEventListener("input", () => { sync(); recalc(); });
  // initialize once
  sync();
}

function init() {
  ensureClientSelector();
  ensureOrientationControls();
  ensureReset();
  wireAutoSick();
  wirePayToCandidate();

  // Recalc on any input/select change
  document.querySelectorAll("input, select").forEach(i => i.addEventListener("input", recalc));
  recalc();
}

function recalc() {
  const client = (el("client") as HTMLSelectElement)?.value || "SimpliFI";
  const fee = CLIENT_FEES[client] || 0;

  // INPUTS
  const billR = valNum("bill_regular", 0);      // Bill Rate
  const billOT = valNum("bill_ot", 0);       // OT Bill Rate
  const payR = valNum("pay_regular", 0);        // W-2 hourly
  const hrsR = valNum("hrs_regular", 0);        // Standard hours/week (REG)
  const hrsOT = valNum("hrs_ot", 0);            // Regular OT hours per week
  const weeks = valNum("contract_len", 0);      // Contract duration in weeks
  const houseDaily = valNum("house_daily", 0);  // Housing Allowance Daily
  const mealsDaily = valNum("meals_daily", 0);  // Meals & Incidentals Daily
  const orientType = (el("orient_type") as HTMLSelectElement)?.value || "Non Billable";
  const orientHours = valNum("orient_hours", 0);
  const orientPay = valNum("orient_pay", 0);
  const bonusStart = valNum("bonus_start", 0);
  const bonusComplete = valNum("bonus_complete", 0);
  const bcgReimb = valNum("bcg_reimb", 0);
  const scheduleDays = valNum("schedule_days", DEFAULT_SCHEDULE_DAYS);

  // ---- Derived base values (Looker Studio mapping) ----

  // Rate after fee
  const hrAfterFee = billR * (1 - fee);
  const otHrAfterFee = billOT * (1 - fee);

  // Hourly stipend components
  const ND = houseDaily + mealsDaily;       // daily non-tax
  const NW = ND * 7;                         // weekly non-tax total
  const NH = hrsR > 40 ? (NW / 40) : (hrsR > 0 ? (NW / hrsR) : 0); // Stipend hourly
  const HA_hourly = hrsR > 40 ? (houseDaily * 7 / 40) : (hrsR > 0 ? (houseDaily * 7 / hrsR) : 0);
  const MI_hourly = hrsR > 40 ? (mealsDaily * 7 / 40) : (hrsR > 0 ? (mealsDaily * 7 / hrsR) : 0);

  // Contract hours
  const contractRegularHours = hrsR * weeks;
  const contractOTHours = hrsOT * weeks;
  const totalContractHours = contractRegularHours + contractOTHours;

  // Sick Pay Hours (auto if checkbox not present OR checked)
  const sickBox = el("auto_sick_calc") as HTMLInputElement;
  const autoSickHours = totalContractHours / 30; // Per formula: (Regular + OT) / 30
  if (!sickBox || (sickBox && sickBox.checked)) setValue("sick_hours", autoSickHours > 0 ? autoSickHours.toFixed(2) : '');
  const sickHours = valNum("sick_hours", autoSickHours);

  // One-time hourlies (cost spread over REGULAR hours)
  const startBonusHourly = contractRegularHours > 0 ? (bonusStart / contractRegularHours) : 0;
  const completeBonusHourly = contractRegularHours > 0 ? (bonusComplete / contractRegularHours) : 0;
  const bcgHourly = contractRegularHours > 0 ? (bcgReimb / contractRegularHours) : 0;
  const sickHourly = contractRegularHours > 0 ? ((sickHours * payR) / contractRegularHours) : 0;

  // Orientation
  const effectiveOrientPay = orientType === "Non Billable" ? 16.5 : orientPay;
  const orientPayRatePerHr = (orientType === "Billable")
    ? (payR + HA_hourly + MI_hourly)
    : effectiveOrientPay;
  const totalOrientationPay = orientHours * orientPayRatePerHr;
  const orientationHourly = (orientType === "Non Billable" && contractRegularHours > 0)
    ? (totalOrientationPay / contractRegularHours)
    : 0;

  // Payroll (taxable)
  const PT_OVERTIME = payR * 1.5;
  // CA OT rule: OT if regular hours > 8/day
  const dailyRegularHours = hrsR / Math.max(1, scheduleDays);
  const OT_if_above_8h = dailyRegularHours > 8 ? (dailyRegularHours - 8) : 0;
  const OT_rate_if_above_40 = (hrsR > 40) ? (PT_OVERTIME + NH) : 0;

  // Weekly On W2 taxable (per CA OT formula)
  const weeklyOnW2Taxable = (hrsR > 40)
    ? (((hrsR - (OT_if_above_8h * scheduleDays)) * payR) + ((OT_if_above_8h * scheduleDays) * OT_rate_if_above_40))
    : (hrsR * payR);

  // Total weekly taxable, including standard OT
  const totalWeeklyTaxableWithOT = weeklyOnW2Taxable + (hrsOT * PT_OVERTIME);

  // Weekly Stipend (Non-Taxable) - per formula
  const weeklyStipendNT = hrsR > 40 ? (hrsR * NW / 40) : NW;

  // Weekly Gross (per formula, does not include hrsOT pay)
  const weeklyGross = weeklyOnW2Taxable + weeklyStipendNT;

  // Client billing (uses after-fee rates)
  const weeklyBillingClient = (hrsR * hrAfterFee) + (hrsOT * otHrAfterFee);
  const monthlyBillingClient = weeklyBillingClient * WEEKS_IN_MONTH;
  const contractBillingClient = weeklyBillingClient * weeks;

  // Hourly Margin (based on regular hours)
  const hourlyMargin =
    hrAfterFee
    - (payR * BURDEN)                                          // W-2 burdened
    - (NH + bcgHourly)                                         // non-tax hourly + bcg (unburdened)
    - ((startBonusHourly + completeBonusHourly + sickHourly) * BURDEN) // one-time burdened
    - (orientType === "Non Billable" ? (orientationHourly * BURDEN) : 0); // non-billable orientation burdened

  // NETs
  const otMargin = otHrAfterFee - (PT_OVERTIME * BURDEN);
  const weeklyNET = (hourlyMargin * hrsR) + (otMargin * hrsOT);
  const monthlyNET = weeklyNET * WEEKS_IN_MONTH;
  const contractNET = weeklyNET * weeks;

  // ---- Write back to UI ----

  // Rate after fee
  setText("afterfee_regular", fmtUSD(hrAfterFee));
  setText("afterfee_ot", fmtUSD(otHrAfterFee));

  // Auto-set OT pay (display next to W-2 input if present)
  setValue("pay_ot", (payR > 0) ? (PT_OVERTIME).toFixed(2) : '');

  // Nurse package
  setText("np_tax_hourly", fmtUSD(payR));
  setText("np_tax_daily", fmtUSD(payR * dailyRegularHours));
  setText("np_tax_weekly", fmtUSD(totalWeeklyTaxableWithOT)); // Full taxable pay
  setText("np_tax_monthly", fmtUSD(totalWeeklyTaxableWithOT * WEEKS_IN_MONTH));

  setText("np_nt_hourly", fmtUSD(NH));
  setText("np_nt_daily", fmtUSD(ND));
  setText("np_nt_weekly", fmtUSD(weeklyStipendNT));
  setText("np_nt_monthly", fmtUSD(weeklyStipendNT * WEEKS_IN_MONTH));

  setText("np_total_hourly", fmtUSD(payR + NH));
  setText("np_total_daily", fmtUSD((payR * dailyRegularHours) + ND));
  setText("np_total_weekly", fmtUSD(totalWeeklyTaxableWithOT + weeklyStipendNT));
  setText("np_total_monthly", fmtUSD((totalWeeklyTaxableWithOT + weeklyStipendNT) * WEEKS_IN_MONTH));

  // Gross margins & billing
  setText("gm_hourly", fmtUSD(hourlyMargin));
  setText("gm_weekly", fmtUSD(weeklyNET));
  setText("gm_monthly", fmtUSD(monthlyNET));
  setText("gm_contract", fmtUSD(contractNET));
  setText("bill_weekly", fmtUSD(weeklyBillingClient));
  setText("bill_monthly", fmtUSD(monthlyBillingClient));
  setText("bill_contract", fmtUSD(contractBillingClient));

  // Package offered to nurse
  setText("pkg_total_hourly", fmtUSD(payR + NH));
  setText("pkg_w2", fmtUSD(payR));
  setText("pkg_w2_ot", fmtUSD(PT_OVERTIME));
  setText("pkg_stipend_hourly", fmtUSD(NH));
  setText("pkg_ot_special", fmtUSD(OT_rate_if_above_40));
  // Weekly Breakdown per formula sheet (ignores hrsOT)
  setText("pkg_weekly_gross", fmtUSD(weeklyGross));
  setText("pkg_weekly_w2", fmtUSD(weeklyOnW2Taxable));
  setText("pkg_weekly_stipend", fmtUSD(weeklyStipendNT));

  // Orientation
  setText("orient_total", fmtUSD(totalOrientationPay));
  
  // Additional Pay (hourly)
  setText("hourly_start", fmtUSD(startBonusHourly));
  setText("hourly_complete", fmtUSD(completeBonusHourly));
  setText("hourly_bcg", fmtUSD(bcgHourly));
  setText("hourly_sick", fmtUSD(sickHourly));

  // Gauge
  renderGauge(hourlyMargin, 20); // Using a more reasonable target margin like $20
}

function renderGauge(margin: number, target: number) {
  const arc = el("gaugeArc") as SVGPathElement;
  const gv = el("gaugeValue");
  const msg = el("ma_message");
  if (gv) gv.textContent = fmtUSD(margin);
  
  if (msg) {
      if (margin === 0 && valNum("bill_regular") === 0) {
          msg.textContent = "Enter numbers to analyze margin."
      } else if (margin < 0) {
          msg.textContent = "Margin is negative. Review pay rates and bill rates."
      } else if (margin < target) {
          msg.textContent = `Margin is below target of ${fmtUSD(target)}.`
      } else {
          msg.textContent = "Margin looks healthy."
      }
  }

  if (!arc) return;
  const r = 60;
  const circ = 2 * Math.PI * r;
  // Gauge shows progress towards 2 * target. Target is the "good" midpoint.
  let progress = target > 0 ? (margin / (target * 2)) : 0; 
  progress = Math.max(0, Math.min(1, progress));
  const offset = circ - progress * circ;
  arc.setAttribute("stroke-dasharray", String(circ));
  arc.setAttribute("stroke-dashoffset", String(offset));
  arc.style.stroke = (margin >= target) ? "#1e8e3e" : (margin > 0 ? "#f9ab00" : "#d93025");
}

document.addEventListener("DOMContentLoaded", init);
