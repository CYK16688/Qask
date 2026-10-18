const path = require('node:path');

const GITHUB_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'gist.github.com',
  'raw.githubusercontent.com',
  'githubusercontent.com',
]);

function normalizeHost(value) {
  return String(value || '').toLowerCase().replace(/\.+$/, '');
}

function isGitHubHost(value) {
  const host = normalizeHost(value);
  return GITHUB_HOSTS.has(host)
    || host.endsWith('.github.com')
    || host.endsWith('.githubusercontent.com')
    || host === 'github.io'
    || host.endsWith('.github.io')
    || host === 'github.dev'
    || host.endsWith('.github.dev');
}

const SENSITIVE_HOME_SEGMENTS = new Set([
  '.gitconfig',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.ssh',
  '.gnupg',
  '.aws',
  '.config',
]);

const SENSITIVE_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.gitconfig',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

const SENSITIVE_FILE_NAME_PATTERNS = [
  /(?:^|[-_.])(github|gitlab|git|ssh|credential|credentials|secret|token|password|passwd|private[-_]?key)(?:[-_.]|$)/i,
];

function normalizePath(value) {
  return path.resolve(String(value || '')).replace(/\\/g, '/');
}

function isPathWithin(candidate, root) {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedRoot = normalizePath(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function hasHiddenOrGitSegment(filePath) {
  const segments = normalizePath(filePath).split('/').filter(Boolean);
  return segments.some((segment) => segment === '.git' || segment.startsWith('.'));
}

function isSensitiveHomePath(filePath, homeDir) {
  if (!homeDir || !isPathWithin(filePath, homeDir)) return false;
  const relativeSegments = normalizePath(filePath)
    .slice(normalizePath(homeDir).length)
    .split('/')
    .filter(Boolean);
  return relativeSegments.some((segment) => SENSITIVE_HOME_SEGMENTS.has(segment));
}

function hasSensitiveFileName(filePath) {
  const fileName = path.basename(normalizePath(filePath));
  return SENSITIVE_FILE_NAMES.has(fileName.toLowerCase())
    || SENSITIVE_FILE_NAME_PATTERNS.some((pattern) => pattern.test(fileName));
}

function inspectAttachmentPath(filePath, {
  homeDir = '',
  userDataDir = '',
  resolvePath = (value) => path.resolve(value),
  isRegularFile = () => true,
} = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { allowed: false, reason: 'missing-path' };
  }

  let resolvedPath;
  try {
    resolvedPath = resolvePath(filePath);
  } catch {
    return { allowed: false, reason: 'unresolvable-path' };
  }

  if (!resolvedPath || hasHiddenOrGitSegment(resolvedPath)) {
    return { allowed: false, reason: 'hidden-or-git-path' };
  }
  if (isSensitiveHomePath(resolvedPath, homeDir)) {
    return { allowed: false, reason: 'sensitive-home-path' };
  }
  if (hasSensitiveFileName(resolvedPath)) {
    return { allowed: false, reason: 'sensitive-file-name' };
  }
  if (userDataDir && isPathWithin(resolvedPath, userDataDir)) {
    return { allowed: false, reason: 'qask-user-data-path' };
  }

  try {
    if (!isRegularFile(resolvedPath)) {
      return { allowed: false, reason: 'not-regular-file' };
    }
  } catch {
    return { allowed: false, reason: 'unreadable-path' };
  }

  return { allowed: true };
}

function isRestrictedCustomProviderUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return true;
    }
    return isGitHubHost(url.hostname);
  } catch {
    return true;
  }
}

const ATTACHMENT_EXTENSION_BY_KIND = {
  image: '.png',
  audio: '.webm',
  document: '.pdf',
};

// Only extensions the queue advertises are kept. Anything else falls back to the
// kind's canonical suffix, so a recording or pasted image never lands on disk as
// an executable or an unopenable intermediate file.
const ATTACHMENT_ALLOWED_EXTENSIONS = {
  image: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']),
  audio: new Set(['.webm', '.ogg', '.mp3', '.wav', '.m4a', '.aac', '.flac']),
  document: new Set(['.pdf']),
};

// The renderer and main process both need a safe basename for files Qask writes
// itself (recordings and pasted images). Keep it a pure function so the rule can
// be tested without an Electron runtime.
function sanitizeAttachmentFileName(name, kind = '') {
  const raw = String(name || '').split(/[\\/]/).pop() || '';
  const rawExtension = path.extname(raw).toLowerCase();
  const rawBase = rawExtension && raw.toLowerCase().endsWith(rawExtension)
    ? raw.slice(0, raw.length - rawExtension.length)
    : raw;
  const safeBase = rawBase
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 64)
    || (kind === 'audio' ? 'qask-recording' : kind === 'image' ? 'qask-image' : 'qask-attachment');
  const allowedExtensions = ATTACHMENT_ALLOWED_EXTENSIONS[kind];
  const safeExtension = allowedExtensions?.has(rawExtension)
    ? rawExtension
    : ATTACHMENT_EXTENSION_BY_KIND[kind] || '.bin';
  return `${safeBase}${safeExtension}`;
}

module.exports = {
  inspectAttachmentPath,
  isRestrictedCustomProviderUrl,
  sanitizeAttachmentFileName,
  ATTACHMENT_EXTENSION_BY_KIND,
};
