// Shared runtime state. Feature files read/update these bindings; config.js holds fixed values.
// Storage and image URLs
let dirHandle = null;
let useLocalFS = false;
let dbPromise = null;
const blobUrlCache = new Map();
const chatBlobCache = new Map();

// Settings and gallery
let formSaveTimer = null;
let currentGalleryFilter = 'all';
let gallerySortAsc = false;
let galleryFlatList = [];
let lightboxIndex = -1;
let galleryResizeTimer = null;

// Generation and upload inputs
let editFiles = [];
let maskFiles = [];
let genController = null;
let genUserStopped = false;
let streamObjectUrl = null;

// Conversation and its current request
let activeConv = null;
let currentView = 'gallery';
let chatBusy = false;
let chatDeleting = false;
let chatController = null;
let chatUserStopped = false;
let chatPartialUrl = null;
let chatRenderVersion = 0;
