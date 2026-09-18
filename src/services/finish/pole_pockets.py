"""Pole pockets / retractable — ported from legacy finisher/polePockets.py.

E logic preserved:
  - pocket size 4.5 in * 72 = 324 px; RET spacing 3 in * 72
  - canvas expansion by mode:
      PPTB  height + 2*324      PPTO/PPBO  height + 324
      PPL/PPR  width + 324      PPS        width + 2*324
      RET   height fixed at 80in*72 + spacing
  - white background canvas, black 2px fold stroke(s), artwork pasted at offset
  - saved TIFF 72dpi tiff_lzw
"""

import os

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None

MODES = ["PPTB", "PPTO", "PPL", "PPR", "PPS", "PPBO", "RET"]

# The canvas has to be built in the SOURCE image's mode, and the fill named per
# mode, because PIL's colour names lie about CMYK: ImageColor.getcolor("white",
# "CMYK") returns (255, 255, 255, 255), which is full ink on every plate --
# solid black. Building an RGB canvas instead (what this did, and what legacy
# does) is quieter but still wrong: Image.paste converts the artwork to the
# canvas mode, so a CMYK print file came out RGB and the press gets a colour
# conversion nobody asked for. Linh's RET reference file is CMYK; ours was not.
#
# Only the two modes that actually reach here are mapped. Anything else keeps
# the old RGB behaviour rather than guessing at an ink value -- a wrong fill is
# a solid band across the pole pocket, which is worse than a colour shift.
_CANVAS_COLOURS = {
    "CMYK": {"white": (0, 0, 0, 0), "black": (0, 0, 0, 255)},
    "RGB": {"white": (255, 255, 255), "black": (0, 0, 0)},
    "L": {"white": 255, "black": 0},
}


def canvas_colour(mode, name):
    """The value for `name` in `mode`, or None when we have no mapping for it."""
    return _CANVAS_COLOURS.get(mode, {}).get(name)


class PolePocketsAdder:
    def __init__(self, polePocketSize=4.5, fillColor="white", mode=None):
        self.polePocketSize = polePocketSize
        self.retractableSpace = 3
        self.fillColor = fillColor
        self.mode = mode

    @property
    def mode(self):
        return self._mode

    @mode.setter
    def mode(self, value):
        if value not in MODES + [None]:
            raise ValueError("Invalid mode for pole pockets.")
        self._mode = value

    @property
    def retractableSpace(self):
        return int(self._retractableSpace * 72)

    @retractableSpace.setter
    def retractableSpace(self, value):
        self._retractableSpace = round(value, 2) if isinstance(value, (int, float)) and value > 0 else 3

    @property
    def polePocketSize(self):
        return int(self._polePocketSize * 72)

    @polePocketSize.setter
    def polePocketSize(self, value):
        self._polePocketSize = round(value, 2) if isinstance(value, (int, float)) and value > 0 else 4.5

    def getOffset(self, mode):
        match mode:
            case "PPTB" | "PPTO":
                return (0, self.polePocketSize)
            case "PPL" | "PPS":
                return (self.polePocketSize, 0)
            case _:
                return (0, 0)  # PPR / PPBO / RET

    def getBackgroundDimensions(self, mode, width, height):
        match mode:
            case "PPTB":
                return (width, height + 2 * self.polePocketSize)
            case "PPTO" | "PPBO":
                return (width, height + self.polePocketSize)
            case "PPL" | "PPR":
                return (width + self.polePocketSize, height)
            case "PPS":
                return (width + 2 * self.polePocketSize, height)
            case "RET":
                return (width, 80 * 72 + self.retractableSpace)

    def addPolePockets(self, mode=None, sourceFileDir=None, convertedFileDir=None,
                       strokeWidth=2, strokeColor="black"):
        if mode is None:
            raise ValueError("No mode specified for pole pockets.")
        self.mode = mode
        if not os.path.exists(sourceFileDir):
            raise FileNotFoundError(f"Source file {sourceFileDir} does not exist.")

        oriImage = Image.open(sourceFileDir)
        newWidth, newHeight = self.getBackgroundDimensions(self.mode, oriImage.width, oriImage.height)

        # Match the artwork's colour space so the paste below does not convert
        # it. Falls back to RGB when the fill cannot be named safely in the
        # source mode -- see _CANVAS_COLOURS.
        fill = canvas_colour(oriImage.mode, self.fillColor)
        stroke = canvas_colour(oriImage.mode, strokeColor)
        if fill is None or stroke is None:
            canvasMode, fill, stroke = "RGB", self.fillColor, strokeColor
        else:
            canvasMode = oriImage.mode

        background = Image.new(canvasMode, (newWidth, newHeight), fill)
        draw = ImageDraw.Draw(background)
        offset = self.getOffset(self.mode)

        match self.mode:
            case "PPTB":
                y_top = offset[1] - strokeWidth // 2
                draw.line([(0, y_top), (newWidth, y_top)], fill=stroke, width=strokeWidth)
                y_bottom = offset[1] + oriImage.height + strokeWidth // 2
                draw.line([(0, y_bottom), (newWidth, y_bottom)], fill=stroke, width=strokeWidth)
            case "PPTO":
                y_top = offset[1] - strokeWidth // 2
                draw.line([(0, y_top), (newWidth, y_top)], fill=stroke, width=strokeWidth)
            case "PPBO" | "RET":
                y_bottom = offset[1] + oriImage.height + strokeWidth // 2
                draw.line([(0, y_bottom), (newWidth, y_bottom)], fill=stroke, width=strokeWidth)
            case "PPL":
                x_left = offset[0] - strokeWidth // 2
                draw.line([(x_left, 0), (x_left, newHeight)], fill=stroke, width=strokeWidth)
            case "PPR":
                x_right = offset[0] + oriImage.width + strokeWidth // 2
                draw.line([(x_right, 0), (x_right, newHeight)], fill=stroke, width=strokeWidth)
            case "PPS":
                x_left = offset[0] - strokeWidth // 2
                x_right = offset[0] + oriImage.width + strokeWidth // 2
                draw.line([(x_left, 0), (x_left, newHeight)], fill=stroke, width=strokeWidth)
                draw.line([(x_right, 0), (x_right, newHeight)], fill=stroke, width=strokeWidth)

        background.paste(oriImage, offset)
        background.save(convertedFileDir, dpi=(72, 72), compression="tiff_lzw")
        return True, "Pole pockets added successfully"
