// opencvLoader.js — loads OpenCV.js locally and resolves when ready.
export function loadOpenCV() {
  return new Promise((resolve) => {
    if (window.cv && window.cv.Mat) { resolve(window.cv); return; }
    const script = document.createElement('script');
    script.src = '/opencv.js';
    script.async = true;
    script.onload = () => {
      const wait = () => {
        if (window.cv && window.cv.Mat) resolve(window.cv);
        else setTimeout(wait, 50);
      };
      // OpenCV.js calls onRuntimeInitialized
      if (window.cv) {
        window.cv.onRuntimeInitialized = () => resolve(window.cv);
      }
      wait();
    };
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}