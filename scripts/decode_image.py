import sys
from PIL import Image
img_path=sys.argv[1]; out_path=sys.argv[2]
im=Image.open(img_path).convert("RGBA")
w,h=im.size
raw=im.tobytes()
open(out_path,"wb").write(raw)
print(w,h)
