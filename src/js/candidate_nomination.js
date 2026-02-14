import { API_BASE } from './config.js';
import { fetchJson } from './utils.js';

function byId(id) {
  return document.getElementById(id);
}

function normalizeKey(s) {
  return String(s || '').trim().toLowerCase();
}

function isDigitsOnly(s) {
  return /^[0-9]+$/.test(String(s || ''));
}

function todayIso() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function setAlert(kind, title, detail) {
  const area = byId('alertArea');
  if (!area) return;
  if (!kind) {
    area.innerHTML = '';
    return;
  }
  area.innerHTML = `
    <div class="alert alert-${kind}">
      <h3>${title}</h3>
      ${detail ? `<p>${detail}</p>` : ''}
    </div>
  `;
}

function setFieldError(fieldId, msg) {
  const field = byId(fieldId)?.closest('.field');
  const err = byId(`${fieldId}_error`);
  if (err) err.textContent = msg || '';
  if (field) {
    field.classList.toggle('is-error', Boolean(msg));
  }
}

function setHasValue(el) {
  const field = el?.closest('.field');
  if (!field) return;
  const v = String(el.value || '').trim();
  field.classList.toggle('has-value', Boolean(v));
}

class CandidateNominationForm {
  constructor() {
    this.knownKeys = [];
    this.submitting = false;
    this.init();
  }

  async init() {
    this.bindFloatingLabels();
    this.bindIndependentToggle();
    this.bindValidation();
    await this.loadKeys();
    this.recompute();
  }

  getValues() {
    return {
      election_name: byId('election_name')?.value?.trim() || '',
      position: byId('position')?.value?.trim() || '',
      full_name: byId('full_name')?.value?.trim() || '',
      date_of_birth: byId('date_of_birth')?.value?.trim() || '',
      address: byId('address')?.value?.trim() || '',
      contact_number: byId('contact_number')?.value?.trim() || '',
      id_number: byId('id_number')?.value?.trim() || '',
      party_name: byId('party_name')?.value?.trim() || '',
      party_symbol: byId('party_symbol')?.value || 'none',
      is_independent: Boolean(byId('is_independent')?.checked),
    };
  }

  bindFloatingLabels() {
    const inputs = document.querySelectorAll('input, textarea, select');
    inputs.forEach((el) => {
      setHasValue(el);
      el.addEventListener('change', () => setHasValue(el));
      el.addEventListener('input', () => setHasValue(el));
      el.addEventListener('blur', () => setHasValue(el));
    });
  }

  bindIndependentToggle() {
    byId('is_independent')?.addEventListener('change', () => {
      const checked = Boolean(byId('is_independent')?.checked);
      const partyName = byId('party_name');
      const partySymbol = byId('party_symbol');
      if (partyName) partyName.disabled = checked;
      if (partySymbol) partySymbol.disabled = checked;
      if (checked) {
        if (partyName) partyName.value = '';
        if (partySymbol) partySymbol.value = 'none';
        setHasValue(partyName);
        setHasValue(partySymbol);
      }
      this.recompute();
    });
  }

  bindValidation() {
    const ids = [
      'election_name',
      'position',
      'full_name',
      'date_of_birth',
      'address',
      'contact_number',
      'id_number',
      'party_name',
      'party_symbol',
      'is_independent',
    ];
    ids.forEach((id) => {
      byId(id)?.addEventListener('input', () => this.recompute());
      byId(id)?.addEventListener('change', () => this.recompute());
    });

    byId('nominationForm')?.addEventListener('submit', (e) => this.onSubmit(e));
  }

  async loadKeys() {
    try {
      const data = await fetchJson(`${API_BASE}/admin/candidate-nominations/keys`);
      this.knownKeys = Array.isArray(data.items) ? data.items : [];
    } catch {
      this.knownKeys = [];
    }
  }

  computeErrors(v) {
    const errs = {};

    if (!v.full_name) errs.full_name = 'Full name is required.';
    if (!v.date_of_birth) errs.date_of_birth = 'Date of birth is required.';
    if (!v.id_number) errs.id_number = 'ID number is required.';

    if (v.date_of_birth) {
      if (v.date_of_birth >= todayIso()) errs.date_of_birth = 'Date of birth must be in the past.';
    }

    if (v.contact_number && !isDigitsOnly(v.contact_number)) {
      errs.contact_number = 'Contact number must be numeric.';
    }

    if (!v.is_independent && !v.party_name) {
      errs.party_name = 'Party name is required unless independent.';
    }

    // Duplicate prechecks (server is still source of truth)
    const keyName = normalizeKey(v.full_name);
    const keyDob = normalizeKey(v.date_of_birth);
    const keyParty = v.is_independent ? '' : normalizeKey(v.party_name);

    if (keyName && keyDob) {
      const dupPerson = this.knownKeys.some(
        (k) => normalizeKey(k.full_name) === keyName && normalizeKey(k.date_of_birth) === keyDob
      );
      if (dupPerson) errs.__dup = 'Duplicate detected: Full Name + Date of Birth already exists.';
    }

    if (keyParty) {
      const dupParty = this.knownKeys.some((k) => normalizeKey(k.party_name) === keyParty);
      if (dupParty) errs.__dup = 'Duplicate detected: Party Name already exists.';
    }

    return errs;
  }

  recompute() {
    const v = this.getValues();
    const errs = this.computeErrors(v);

    setFieldError('full_name', errs.full_name);
    setFieldError('date_of_birth', errs.date_of_birth);
    setFieldError('id_number', errs.id_number);
    setFieldError('contact_number', errs.contact_number);
    setFieldError('party_name', errs.party_name);

    if (errs.__dup) {
      setAlert('error', 'Duplicate Detected', errs.__dup);
    } else {
      // Only clear duplicate alert if we didn't just submit an error/success.
      // Keep existing success message until user types again.
      const area = byId('alertArea');
      const hasSuccess = area?.querySelector('.alert-success');
      const hasError = area?.querySelector('.alert-error');
      if (hasError && !hasSuccess) setAlert(null, '', '');
    }

    const blocking = Object.keys(errs).some((k) => !k.startsWith('__'));
    const dup = Boolean(errs.__dup);
    const canSubmit = !blocking && !dup && !this.submitting;
    const submitBtn = byId('submitBtn');
    if (submitBtn) submitBtn.disabled = !canSubmit;
  }

  async onSubmit(e) {
    e.preventDefault();
    if (this.submitting) return;

    const v = this.getValues();
    const errs = this.computeErrors(v);
    this.recompute();

    if (errs.__dup) {
      setAlert('error', 'Duplicate Detected', errs.__dup);
      return;
    }
    const blocking = Object.keys(errs).some((k) => !k.startsWith('__'));
    if (blocking) {
      setAlert('error', 'Action Required', 'Please fix the highlighted fields.');
      return;
    }

    this.submitting = true;
    this.recompute();
    setAlert('info', 'Submitting', 'Validating...');

    const payload = {
      election_name: v.election_name || null,
      position: v.position || null,
      full_name: v.full_name,
      date_of_birth: v.date_of_birth,
      address: v.address || null,
      contact_number: v.contact_number || null,
      id_number: v.id_number,
      party_name: v.is_independent ? null : v.party_name,
      party_symbol: v.is_independent ? null : (v.party_symbol === 'none' ? null : v.party_symbol),
      is_independent: Boolean(v.is_independent),
    };

    try {
      // Server-side duplicate check before chain tx.
      await fetchJson(`${API_BASE}/admin/candidate-nominations/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      // Must be embedded inside admin (parent runs chain tx + DB upsert).
      const embedded = window.parent && window.parent !== window;
      if (!embedded) {
        throw new Error('Open this form inside the Admin portal.');
      }

      setAlert('info', 'Submitting', 'Submitting to blockchain...');
      const requestId = `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const chainRes = await new Promise((resolve) => {
        const onMsg = (ev) => {
          const m = ev?.data || {};
          if (m.type !== 'NOMINATION_ADD_CANDIDATE_RESULT') return;
          if (m.requestId !== requestId) return;
          window.removeEventListener('message', onMsg);
          resolve(m);
        };
        window.addEventListener('message', onMsg);

        const chainName = v.full_name;
        const chainParty = v.is_independent ? 'Independent' : v.party_name;
        const symbol = v.is_independent ? '' : (v.party_symbol === 'none' ? '' : v.party_symbol);
        window.parent.postMessage(
          { type: 'NOMINATION_ADD_CANDIDATE', requestId, payload: { name: chainName, party: chainParty, symbol } },
          '*'
        );
      });

      if (!chainRes || chainRes.ok !== true) {
        throw new Error(chainRes?.error || 'Blockchain submission failed.');
      }

      setAlert('info', 'Submitting', 'Saving nomination record...');
      await fetchJson(`${API_BASE}/admin/candidate-nominations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      setAlert('success', 'Submitted', `Candidate added (ID ${chainRes.candidate_id}) and nomination saved.`);

      byId('nominationForm')?.reset();
      // Reset party symbol to default and labels to correct state
      const partySymbol = byId('party_symbol');
      if (partySymbol) partySymbol.value = 'none';
      document.querySelectorAll('input, textarea, select').forEach((el) => setHasValue(el));

      await this.loadKeys();
    } catch (err) {
      setAlert('error', 'Action Required', err?.message || String(err));
    } finally {
      this.submitting = false;
      this.recompute();
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new CandidateNominationForm();
});

