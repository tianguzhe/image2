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
// Appended to every chat edit: the prompting guide advises restating what must stay
// unchanged on each iteration, since repeated edits drift otherwise.
const CHAT_EDIT_CONSTRAINT = '只修改上述指令提到的部分；其餘構圖、主體、光線、風格保持不變；不要加入文字或浮水印。';

// Edit input limits from the Images API reference: png/jpeg/webp, each < 50MB, up to 16 images.
const EDIT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_EDIT_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_EDIT_IMAGES = 16;

// Validation constants
const VALID_FORMATS = ['png', 'jpeg', 'webp'];
const VALID_TYPES = ['generate', 'edit'];

const PERSIST_FIELDS = [
  'prompt', 'size', 'customSize', 'quality', 'background', 'format', 'compression', 'partials',
  'editPrompt', 'editSize', 'editCustomSize', 'editQuality', 'editBackground', 'editFormat', 'editCompression'
];
const PERSIST_KEY = 'gpt_image_form';
const FS_SUPPORTED = 'showDirectoryPicker' in window;
