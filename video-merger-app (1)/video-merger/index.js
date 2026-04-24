const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── folders ───────────────────────────────────────────────────────────────────
const UPLOADS_DIR  = path.join(__dirname, 'uploads');
const OUTPUTS_DIR  = path.join(__dirname, 'outputs');
const NORM_DIR     = path.join(__dirname, 'normalized');
const INTRO        = path.join(__dirname, 'intro.mp4');
const OUTRO        = path.join(__dirname, 'outro.mp4');

[UPLOADS_DIR, OUTPUTS_DIR, NORM_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, `upload_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// ── helpers ───────────────────────────────────────────────────────────────────

/** Re-encode to H.264 1280x720 30fps so all clips are identical format */
function normalize(inputPath, outputPath) {
  execSync(
    `ffmpeg -y -i "${inputPath}" ` +
    `-vf "scale=1280:720:force_original_aspect_ratio=decrease,` +
    `pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30" ` +
    `-c:v libx264 -preset fast -crf 23 ` +
    `-c:a aac -b:a 128k -ar 44100 -ac 2 ` +
    `"${outputPath}"`,
    { stdio: 'inherit' }
  );
}

/**
 * Add text overlay using FFmpeg drawtext filter.
 * Text: "Dr {name} | {specialization} | {city}"
 * Position: centered horizontally, 50px from top
 */
function addTextOverlay(inputPath, outputPath, name, specialization, city) {
  // Escape special chars that break FFmpeg drawtext
  const escape = str => str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\u2019')
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');

  const text = `Dr ${escape(name)} | ${escape(specialization)} | ${escape(city)}`;

  const drawtext =
    `drawtext=text='${text}':` +
    `fontsize=32:` +
    `fontcolor=white:` +
    `box=1:boxcolor=black@0.6:boxborderw=10:` +
    `x=(w-text_w)/2:y=50`;

  execSync(
    `ffmpeg -y -i "${inputPath}" -vf "${drawtext}" ` +
    `-c:v libx264 -preset fast -crf 23 ` +
    `-c:a aac -b:a 128k -ar 44100 -ac 2 ` +
    `"${outputPath}"`,
    { stdio: 'inherit' }
  );
}

// ── static HTML ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/outputs', express.static(OUTPUTS_DIR));

// ── upload + overlay + merge route ───────────────────────────────────────────
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const name           = (req.body.name           || '').trim();
  const specialization = (req.body.specialization || '').trim();
  const city           = (req.body.city           || '').trim();

  const ts            = Date.now();
  const uploadedRaw   = req.file.path;
  const normIntro     = path.join(NORM_DIR, `intro_${ts}.mp4`);
  const normUser      = path.join(NORM_DIR, `user_${ts}.mp4`);
  const processedUser = path.join(NORM_DIR, `processed_${ts}.mp4`);
  const normOutro     = path.join(NORM_DIR, `outro_${ts}.mp4`);
  const outputFile    = path.join(OUTPUTS_DIR, `merged_${ts}.mp4`);
  const filelistPath  = path.join(NORM_DIR, `filelist_${ts}.txt`);

  try {
    // Step 1 — Normalize all clips to same format
    console.log('Normalizing intro…');
    normalize(INTRO, normIntro);

    console.log('Normalizing uploaded video…');
    normalize(uploadedRaw, normUser);

    console.log('Normalizing outro…');
    normalize(OUTRO, normOutro);

    // Step 2 — Add text overlay on user's video
    if (name && specialization && city) {
      console.log(`Adding overlay: Dr ${name} | ${specialization} | ${city}`);
      addTextOverlay(normUser, processedUser, name, specialization, city);
    } else {
      // No text provided — just copy normalized video as-is
      fs.copyFileSync(normUser, processedUser);
    }

    // Step 3 — Build concat filelist
    const list = [
      `file '${normIntro}'`,
      `file '${processedUser}'`,
      `file '${normOutro}'`
    ].join('\n');
    fs.writeFileSync(filelistPath, list);

    // Step 4 — Concat: intro + processed + outro
    console.log('Concatenating final video…');
    execSync(
      `ffmpeg -y -f concat -safe 0 -i "${filelistPath}" -c copy "${outputFile}"`,
      { stdio: 'inherit' }
    );

    // Cleanup temp files
    [normIntro, normUser, processedUser, normOutro, filelistPath].forEach(f => {
      try { fs.unlinkSync(f); } catch (_) {}
    });

    const downloadPath = '/outputs/' + path.basename(outputFile);
    res.json({ success: true, videoPath: downloadPath });

  } catch (err) {
    console.error('Processing error:', err.message);
    res.status(500).json({ error: 'FFmpeg failed: ' + err.message });
  }
});

// ── start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
