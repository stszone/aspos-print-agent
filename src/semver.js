/** Strict x.y.z semver helpers. Anything else (pre-release, garbage) is "invalid". */

const RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(v) {
    const m = RE.exec(String(v ?? '').trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** @returns {number|null} -1/0/1, or null when either side is not valid x.y.z */
export function compareSemver(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb) return null;
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    }
    return 0;
}

/** True only when `candidate` is strictly newer than `current` (never downgrade). */
export function isNewer(candidate, current) {
    return compareSemver(candidate, current) === 1;
}
