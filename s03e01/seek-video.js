// Runs inside s03e01/video-viewer.html: pauses the recording at ?t=<seconds> and reports what the
// video element is actually showing, so a frame is captured at a known second.
(async () => {
  const video = document.getElementById('v');
  if (!video) {
    return 'no video element';
  }
  video.pause();
  const target = Number(new URLSearchParams(location.search).get('t') ?? 0);
  await new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 4000);
    if (Math.abs(video.currentTime - target) < 0.05 && video.readyState >= 2) {
      return done();
    }
    video.addEventListener('seeked', done, { once: true });
    video.currentTime = target;
  });
  return JSON.stringify({
    requested: target,
    currentTime: Number(video.currentTime.toFixed(2)),
    duration: Number((video.duration || 0).toFixed(2)),
    width: video.videoWidth,
    height: video.videoHeight,
    readyState: video.readyState,
  });
})();
