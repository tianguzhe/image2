// ===== Constants =====
const DEFAULT_BASE_URL = '';
const STORAGE_KEY = 'gpt_image_history';
const APIKEY_KEY = 'gpt_image_apikey';
const BASEURL_KEY = 'gpt_image_baseurl';
const DB_NAME = 'gpt_image_db';
const DB_STORE = 'history';
const DB_SETTINGS = 'settings';
const DB_CONV = 'conversations';

// API timeouts and limits
const API_TIMEOUT_MS = 300000; // 5 minutes
const MAX_B64_LENGTH = 50 * 1024 * 1024; // 50MB
const MAX_IMAGES_PER_ITEM = 20;
const BATCH_SIZE = 20;
const IMAGE_MODEL = 'gpt-image-2.5-sunburst';

// Validation constants
const VALID_FORMATS = ['png', 'jpeg', 'webp'];
const VALID_TYPES = ['generate', 'edit'];

const PERSIST_FIELDS = [
  'prompt', 'size', 'customSize', 'quality', 'format', 'compression', 'partials',
  'editPrompt', 'editSize', 'editCustomSize', 'editQuality', 'editFormat', 'editCompression'
];
const PERSIST_KEY = 'gpt_image_form';
const FS_SUPPORTED = 'showDirectoryPicker' in window;
