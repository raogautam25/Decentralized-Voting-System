import { API_BASE } from './config.js';
import { fetchJson } from './utils.js';

function byId(id) {
  return document.getElementById(id);
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isDigitsOnly(value) {
  return /^[0-9]+$/.test(String(value || '').trim());
}

function todayIso() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function calculateAgeFromIso(isoDate) {
  if (!isoDate) return 0;
  const dob = new Date(`${isoDate}T00:00:00`);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDelta = today.getMonth() - dob.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < dob.getDate())) {
    age -= 1;
  }
  return age;
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default-election';
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

function setFieldError(fieldId, message) {
  const field = byId(fieldId)?.closest('.field');
  const errorNode = byId(`${fieldId}_error`);
  if (errorNode) errorNode.textContent = message || '';
  if (field) {
    field.classList.toggle('is-error', Boolean(message));
  }
}

function setHasValue(element) {
  const field = element?.closest('.field');
  if (!field) return;
  field.classList.toggle('has-value', Boolean(String(element.value || '').trim()));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Unable to read selected file.'));
    reader.readAsDataURL(file);
  });
}

function presetSymbolPreview(symbol) {
  const presets = {
    torch: ['Torch', '#f97316', 'T'],
    eagle: ['Eagle', '#2563eb', 'E'],
    tree: ['Tree', '#16a34a', 'Tr'],
    sun: ['Sun', '#eab308', 'S'],
    scale: ['Scales', '#7c3aed', 'Sc'],
    star: ['Star', '#dc2626', 'St'],
  };
  const current = presets[symbol];
  if (!current) return '';
  const [label, color, short] = current;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="180" height="110" viewBox="0 0 180 110">
      <rect x="4" y="4" width="172" height="102" rx="16" fill="#ffffff" stroke="${color}" stroke-width="4"/>
      <circle cx="48" cy="55" r="24" fill="${color}" opacity="0.14"/>
      <text x="48" y="62" text-anchor="middle" font-size="18" font-family="Arial, sans-serif" font-weight="700" fill="${color}">${short}</text>
      <text x="88" y="50" font-size="18" font-family="Arial, sans-serif" font-weight="700" fill="#0f172a">${label}</text>
      <text x="88" y="72" font-size="12" font-family="Arial, sans-serif" fill="#475569">Preset party symbol</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

class CandidateNominationForm {
  constructor() {
    this.knownKeys = [];
    this.submitting = false;
    this.uploadedSymbolDataUrl = '';
    this.init();
  }

  async init() {
    this.bindFloatingLabels();
    this.bindIndependentToggle();
    this.bindPartySymbolPreview();
    this.bindValidation();
    await this.loadKeys();
    this.updateSymbolPreview();
    this.recompute();
  }

  getValues() {
    return {
      election_id: byId('election_id')?.value?.trim() || '',
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
      party_symbol_image_data: this.uploadedSymbolDataUrl || '',
    };
  }

  bindFloatingLabels() {
    const elements = document.querySelectorAll('input, textarea, select');
    elements.forEach((element) => {
      setHasValue(element);
      element.addEventListener('change', () => setHasValue(element));
      element.addEventListener('input', () => setHasValue(element));
      element.addEventListener('blur', () => setHasValue(element));
    });
  }

  bindIndependentToggle() {
    byId('is_independent')?.addEventListener('change', () => {
      const checked = Boolean(byId('is_independent')?.checked);
      const partyName = byId('party_name');
      const partySymbol = byId('party_symbol');
      const partyUpload = byId('party_symbol_upload');
      if (partyName) partyName.disabled = checked;
      if (partySymbol) partySymbol.disabled = checked;
      if (partyUpload) partyUpload.disabled = checked;
      if (checked) {
        if (partyName) partyName.value = '';
        if (partySymbol) partySymbol.value = 'none';
        if (partyUpload) partyUpload.value = '';
        this.uploadedSymbolDataUrl = '';
        setHasValue(partyName);
        setHasValue(partySymbol);
      }
      this.updateSymbolPreview();
      this.recompute();
    });
  }

  bindPartySymbolPreview() {
    byId('party_symbol')?.addEventListener('change', () => {
      this.updateSymbolPreview();
      this.recompute();
    });
    byId('party_symbol_upload')?.addEventListener('change', async (event) => {
      const file = event?.target?.files?.[0];
      if (!file) {
        this.uploadedSymbolDataUrl = '';
        this.updateSymbolPreview();
        this.recompute();
        return;
      }
      try {
        this.uploadedSymbolDataUrl = await readFileAsDataUrl(file);
        this.updateSymbolPreview();
        this.recompute();
      } catch (error) {
        setAlert('error', 'Upload Failed', error.message);
      }
    });
  }

  bindValidation() {
    const ids = [
      'election_id',
      'election_name',
      'position',
      'full_name',
      'date_of_birth',
      'address',
      'contact_number',
      'id_number',
      'party_name',
      'party_symbol',
      'party_symbol_upload',
      'is_independent',
    ];
    ids.forEach((id) => {
      byId(id)?.addEventListener('input', () => this.recompute());
      byId(id)?.addEventListener('change', () => this.recompute());
    });
    byId('nominationForm')?.addEventListener('submit', (event) => this.onSubmit(event));
  }

  async loadKeys() {
    try {
      const data = await fetchJson(`${API_BASE}/admin/candidate-nominations/keys`);
      this.knownKeys = Array.isArray(data.items) ? data.items : [];
    } catch {
      this.knownKeys = [];
    }
  }

  updateSymbolPreview() {
    const image = byId('partySymbolPreview');
    const emptyState = byId('partySymbolPreviewEmpty');
    const values = this.getValues();

    let previewSrc = '';
    if (!values.is_independent && values.party_symbol_image_data) {
      previewSrc = values.party_symbol_image_data;
    } else if (!values.is_independent && values.party_symbol !== 'none') {
      previewSrc = presetSymbolPreview(values.party_symbol);
    }

    if (previewSrc) {
      image.src = previewSrc;
      image.hidden = false;
      emptyState.hidden = true;
    } else {
      image.removeAttribute('src');
      image.hidden = true;
      emptyState.hidden = false;
      emptyState.textContent = values.is_independent
        ? 'Independent candidates do not require a party symbol'
        : 'No party symbol selected';
    }
  }

  computeErrors(values) {
    const errors = {};
    if (!values.full_name) errors.full_name = 'Full name is required.';
    if (!values.date_of_birth) errors.date_of_birth = 'Date of birth is required.';
    if (!values.id_number) errors.id_number = 'ID number is required.';

    if (values.date_of_birth) {
      if (values.date_of_birth >= todayIso()) {
        errors.date_of_birth = 'Date of birth must be in the past.';
      } else if (calculateAgeFromIso(values.date_of_birth) < 18) {
        errors.date_of_birth = 'Candidate must be at least 18 years old.';
      }
    }

    if (values.contact_number && !isDigitsOnly(values.contact_number)) {
      errors.contact_number = 'Contact number must be numeric.';
    }

    if (!values.is_independent && !values.party_name) {
      errors.party_name = 'Party name is required unless independent.';
    }

    const electionId = slugify(values.election_id || values.election_name);
    const dupRecord = this.knownKeys.find((item) =>
      normalizeKey(item.full_name) === normalizeKey(values.full_name) &&
      normalizeKey(item.date_of_birth) === normalizeKey(values.date_of_birth) &&
      normalizeKey(item.contact_number) === normalizeKey(values.contact_number) &&
      normalizeKey(item.id_number) === normalizeKey(values.id_number)
    );
    if (dupRecord) {
      errors.__duplicate = 'Candidate already exists in database';
    }

    const dupElection = this.knownKeys.find((item) =>
      normalizeKey(item.election_id) === normalizeKey(electionId) &&
      normalizeKey(item.full_name) === normalizeKey(values.full_name) &&
      normalizeKey(item.date_of_birth) === normalizeKey(values.date_of_birth) &&
      normalizeKey(item.id_number) === normalizeKey(values.id_number)
    );
    if (dupElection) {
      errors.__election = 'Candidate is already registered for this election';
    }

    return errors;
  }

  recompute() {
    const values = this.getValues();
    const errors = this.computeErrors(values);

    setFieldError('full_name', errors.full_name);
    setFieldError('date_of_birth', errors.date_of_birth);
    setFieldError('id_number', errors.id_number);
    setFieldError('contact_number', errors.contact_number);
    setFieldError('party_name', errors.party_name);

    if (errors.__duplicate) {
      setAlert('error', 'Duplicate Detected', errors.__duplicate);
    } else if (errors.__election) {
      setAlert('error', 'Election Rule', errors.__election);
    } else {
      const area = byId('alertArea');
      const hasSuccess = area?.querySelector('.alert-success');
      const hasError = area?.querySelector('.alert-error');
      if (hasError && !hasSuccess) setAlert(null, '', '');
    }

    const blocking = Object.keys(errors).some((key) => !key.startsWith('__'));
    const submitButton = byId('submitBtn');
    if (submitButton) submitButton.disabled = blocking || Boolean(errors.__duplicate) || Boolean(errors.__election) || this.submitting;
  }

  async onSubmit(event) {
    event.preventDefault();
    if (this.submitting) return;

    const values = this.getValues();
    const errors = this.computeErrors(values);
    this.recompute();

    if (errors.__duplicate || errors.__election) {
      setAlert('error', 'Action Required', errors.__duplicate || errors.__election);
      return;
    }

    const blocking = Object.keys(errors).some((key) => !key.startsWith('__'));
    if (blocking) {
      setAlert('error', 'Action Required', 'Please fix the highlighted fields.');
      return;
    }

    this.submitting = true;
    this.recompute();
    setAlert('info', 'Submitting', 'Validating nomination details...');

    const payload = {
      election_id: values.election_id || null,
      election_name: values.election_name || null,
      position: values.position || null,
      full_name: values.full_name,
      date_of_birth: values.date_of_birth,
      address: values.address || null,
      contact_number: values.contact_number || null,
      id_number: values.id_number,
      party_name: values.is_independent ? null : values.party_name,
      party_symbol: values.is_independent ? null : (values.party_symbol === 'none' ? null : values.party_symbol),
      party_symbol_image_data: values.is_independent ? null : (values.party_symbol_image_data || null),
      is_independent: Boolean(values.is_independent),
    };

    try {
      const precheck = await fetchJson(`${API_BASE}/admin/candidate-nominations/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      payload.election_id = precheck.election_id || payload.election_id;

      const embedded = window.parent && window.parent !== window;
      if (!embedded) {
        throw new Error('Open this form inside the Admin portal.');
      }

      setAlert('info', 'Submitting', 'Submitting to blockchain...');
      const requestId = `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const chainResult = await new Promise((resolve) => {
        const onMessage = (ev) => {
          const message = ev?.data || {};
          if (message.type !== 'NOMINATION_ADD_CANDIDATE_RESULT') return;
          if (message.requestId !== requestId) return;
          window.removeEventListener('message', onMessage);
          resolve(message);
        };

        window.addEventListener('message', onMessage);
        window.parent.postMessage(
          {
            type: 'NOMINATION_ADD_CANDIDATE',
            requestId,
            payload: {
              name: values.full_name,
              party: values.is_independent ? 'Independent' : values.party_name,
            },
          },
          '*'
        );
      });

      if (!chainResult || chainResult.ok !== true) {
        throw new Error(chainResult?.error || 'Blockchain submission failed.');
      }

      payload.candidate_id = chainResult.candidate_id;

      setAlert('info', 'Submitting', 'Saving nomination record...');
      const nominationResult = await fetchJson(`${API_BASE}/admin/candidate-nominations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      await fetchJson(`${API_BASE}/admin/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidate_id: chainResult.candidate_id,
          name: values.full_name,
          party: values.is_independent ? 'Independent' : values.party_name,
          symbol: values.is_independent ? '' : (values.party_symbol === 'none' ? '' : values.party_symbol),
          date_of_birth: values.date_of_birth,
          party_symbol_image: nominationResult.party_symbol_image || null,
        }),
      });

      setAlert('success', 'Submitted', `Candidate added (ID ${chainResult.candidate_id}) and nomination saved.`);
      byId('nominationForm')?.reset();
      byId('party_symbol').value = 'none';
      byId('party_symbol_upload').value = '';
      this.uploadedSymbolDataUrl = '';
      document.querySelectorAll('input, textarea, select').forEach((element) => setHasValue(element));
      this.updateSymbolPreview();
      await this.loadKeys();
    } catch (error) {
      setAlert('error', 'Action Required', error?.message || String(error));
    } finally {
      this.submitting = false;
      this.recompute();
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new CandidateNominationForm();
});
