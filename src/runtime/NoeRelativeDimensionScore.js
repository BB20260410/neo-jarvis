// @ts-check
/**
 * Pure relative labels for Neo vs BaiLongma dimension scores.
 * Labels are ALWAYS derived from numeric scores + measurement flags —
 * never hand-assigned independently of the numbers.
 */

/** @typedef {'neo_leads'|'neo_not_below'|'neo_below'|'ceiling_tie'|'non_comparable'|'pending_owner_waived'} RelativeLabel */

export const RELATIVE_LABELS = Object.freeze([
  'neo_leads',
  'neo_not_below',
  'neo_below',
  'ceiling_tie',
  'non_comparable',
  'pending_owner_waived',
]);

export const RELATIVE_PASS_LABELS = Object.freeze([
  'neo_leads',
  'neo_not_below',
  'ceiling_tie',
]);

/** Dimensions that must not use inequivalent proxy BL stand-ins */
export const PROXY_FORBIDDEN_DIMS = Object.freeze(['D06', 'D09', 'D10', 'D11']);

/**
 * @param {number|null|undefined} neoScore
 * @param {number|null|undefined} bailongmaScore
 * @param {{
 *   leadEpsilon?: number,
 *   ceiling?: number,
 *   comparable?: boolean,
 *   measurementEquivalent?: boolean,
 *   neoInputComplete?: boolean,
 *   bailongmaInputComplete?: boolean,
 *   isProxy?: boolean,
 *   pendingOwnerWaived?: boolean,
 *   reasonIfNonComparable?: string|null,
 * }} [opts]
 * @returns {{ relative: RelativeLabel, relativeReason: string|null, lead: number|null, leadPp: number|null }}
 */
export function computeRelativeLabel(neoScore, bailongmaScore, opts = {}) {
  const leadEpsilon = Number.isFinite(opts.leadEpsilon) ? Number(opts.leadEpsilon) : 0.099;
  const ceiling = Number.isFinite(opts.ceiling) ? Number(opts.ceiling) : 1;
  const comparable = opts.comparable !== false;
  // Fail closed: equivalence and real input completeness must be explicit.
  const measurementEquivalent = opts.measurementEquivalent === true;
  const neoInputComplete = opts.neoInputComplete === true;
  const bailongmaInputComplete = opts.bailongmaInputComplete === true;
  const isProxy = opts.isProxy === true;
  const pendingOwnerWaived = opts.pendingOwnerWaived === true;
  const reasonIfNonComparable = opts.reasonIfNonComparable || null;

  if (pendingOwnerWaived) {
    return {
      relative: 'pending_owner_waived',
      relativeReason: reasonIfNonComparable || 'owner_waived_pending_soak_or_external',
      lead: null,
      leadPp: null,
    };
  }

  if (isProxy || !comparable || !measurementEquivalent) {
    return {
      relative: 'non_comparable',
      relativeReason:
        reasonIfNonComparable ||
        (isProxy
          ? 'inequivalent_proxy_measurement_removed'
          : !measurementEquivalent
            ? 'measurement_methods_not_equivalent'
            : 'not_comparable'),
      lead: null,
      leadPp: null,
    };
  }

  if (!neoInputComplete || !bailongmaInputComplete) {
    return {
      relative: 'non_comparable',
      relativeReason:
        reasonIfNonComparable ||
        (!neoInputComplete && !bailongmaInputComplete
          ? 'real_inputs_incomplete_both_sides'
          : !neoInputComplete
            ? 'neo_real_input_incomplete'
            : 'bailongma_real_input_incomplete'),
      lead: null,
      leadPp: null,
    };
  }

  const neo = neoScore == null || !Number.isFinite(Number(neoScore)) ? null : Number(neoScore);
  const bl =
    bailongmaScore == null || !Number.isFinite(Number(bailongmaScore))
      ? null
      : Number(bailongmaScore);

  if (neo == null || bl == null) {
    return {
      relative: 'non_comparable',
      relativeReason: reasonIfNonComparable || 'missing_score_one_or_both_sides',
      lead: null,
      leadPp: null,
    };
  }

  const lead = neo - bl;
  const leadPp = lead * 100;

  if (neo >= ceiling - 1e-12 && bl >= ceiling - 1e-12) {
    return {
      relative: 'ceiling_tie',
      relativeReason: 'both_at_ceiling',
      lead: 0,
      leadPp: 0,
    };
  }

  if (lead > leadEpsilon) {
    return { relative: 'neo_leads', relativeReason: null, lead, leadPp };
  }

  if (neo + 1e-12 >= bl) {
    return { relative: 'neo_not_below', relativeReason: null, lead, leadPp };
  }

  return {
    relative: 'neo_below',
    relativeReason: 'neo_score_below_bailongma',
    lead,
    leadPp,
  };
}

/**
 * Assert a claimed label matches what the numeric rule produces.
 * @param {string} claimed
 * @param {number|null|undefined} neoScore
 * @param {number|null|undefined} bailongmaScore
 * @param {Parameters<typeof computeRelativeLabel>[2]} [opts]
 */
export function labelMatchesScores(claimed, neoScore, bailongmaScore, opts = {}) {
  const expected = computeRelativeLabel(neoScore, bailongmaScore, opts);
  return {
    ok: claimed === expected.relative,
    claimed,
    expected: expected.relative,
    expectedReason: expected.relativeReason,
  };
}

/**
 * Recompute relative fields on a dimension row (mutates a shallow copy).
 * @param {{
 *   id?: string,
 *   name?: string,
 *   neoScore?: number|null,
 *   bailongmaScore?: number|null,
 *   relative?: string,
 *   relativeReason?: string|null,
 *   isProxy?: boolean,
 *   measurementEquivalent?: boolean,
 *   neoInputComplete?: boolean,
 *   bailongmaInputComplete?: boolean,
 *   comparable?: boolean,
 *   pendingOwnerWaived?: boolean,
 * }} dim
 * @param {Parameters<typeof computeRelativeLabel>[2]} [opts]
 */
export function recomputeDimensionRelative(dim, opts = {}) {
  const id = dim?.id || '';
  const pendingOwnerWaived =
    opts.pendingOwnerWaived === true ||
    dim?.pendingOwnerWaived === true;
  const isProxy =
    opts.isProxy === true ||
    dim?.isProxy === true ||
    (PROXY_FORBIDDEN_DIMS.includes(id) && dim?.isProxy !== false && dim?.measurementEquivalent === false);
  const computed = computeRelativeLabel(dim?.neoScore, dim?.bailongmaScore, {
    ...opts,
    pendingOwnerWaived,
    isProxy: isProxy && !pendingOwnerWaived ? true : opts.isProxy,
    measurementEquivalent:
      opts.measurementEquivalent ?? dim?.measurementEquivalent ?? false,
    neoInputComplete:
      opts.neoInputComplete ?? dim?.neoInputComplete ?? false,
    bailongmaInputComplete:
      opts.bailongmaInputComplete ?? dim?.bailongmaInputComplete ?? false,
    comparable: opts.comparable ?? dim?.comparable ?? true,
    reasonIfNonComparable:
      opts.reasonIfNonComparable ??
      dim?.relativeReason ??
      (pendingOwnerWaived ? 'D08_pending_owner_waived_soak' : null),
  });
  return {
    ...dim,
    relative: computed.relative,
    relativeReason: computed.relativeReason,
    lead: computed.lead,
    leadPp: computed.leadPp,
  };
}

/**
 * Produce non-overloaded dimension counts. `stated` only means a label exists;
 * it is never used as a completion or pass count.
 * @param {Array<{id?: string, relative?: string|null}>} dimensions
 */
export function summarizeRelativeDimensions(dimensions = []) {
  const rows = Array.isArray(dimensions) ? dimensions : [];
  const ids = (items) => items.map((d) => d.id || '').filter(Boolean);
  const statedRows = rows.filter((d) => RELATIVE_LABELS.includes(/** @type {RelativeLabel} */ (d.relative)));
  const comparableRows = rows.filter((d) =>
    [...RELATIVE_PASS_LABELS, 'neo_below'].includes(d.relative || ''),
  );
  const relativePassRows = rows.filter((d) => RELATIVE_PASS_LABELS.includes(/** @type {RelativeLabel} */ (d.relative)));
  const nonComparableRows = rows.filter((d) => d.relative === 'non_comparable');
  const pendingOwnerWaivedRows = rows.filter((d) => d.relative === 'pending_owner_waived');
  const neoBelowRows = rows.filter((d) => d.relative === 'neo_below');
  const pendingRows = rows.filter(
    (d) => !RELATIVE_LABELS.includes(/** @type {RelativeLabel} */ (d.relative)),
  );

  return {
    total: rows.length,
    stated: statedRows.length,
    statedIds: ids(statedRows),
    statedBar: `${statedRows.length}/${rows.length}`,
    comparable: comparableRows.length,
    comparableIds: ids(comparableRows),
    relativePass: relativePassRows.length,
    relativePassIds: ids(relativePassRows),
    relativePassBar: `${relativePassRows.length}/${rows.length}`,
    nonComparable: nonComparableRows.length,
    nonComparableIds: ids(nonComparableRows),
    pending: pendingRows.length,
    pendingIds: ids(pendingRows),
    pendingOwnerWaived: pendingOwnerWaivedRows.length,
    pendingOwnerWaivedIds: ids(pendingOwnerWaivedRows),
    neoBelow: neoBelowRows.length,
    neoBelowIds: ids(neoBelowRows),
    complete: rows.length > 0 && relativePassRows.length === rows.length,
  };
}
