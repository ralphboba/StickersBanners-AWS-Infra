"""Grommet placement — ported verbatim from legacy finisher/grommets.py.

D logic preserved:
  - corner inset: 0.75 ft * 72 = 54 px from each edge
  - a grommet mark = three concentric circles drawn with ImageDraw.ellipse:
      black border (r = radius+outline+border), white outline (r = radius+outline),
      red fill (r = radius)
  - corners always; sides with >2 grommets spaced evenly:
      spacing = (length - 2*inset) / (count - 1)
  - sides limited to those requested; corner duplicates removed
  - saved at 72 DPI
"""

import os

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None


class GrommetsAdder:
    def __init__(self, cornerGrommets=0.75, grommetRadius=4, grommetOutlineWidth=2,
                 fillColor="red", outlineColor="white", borderColor="black"):
        self.ImageInstance = None
        self.cornerGrommets = cornerGrommets
        self.grommetRadius = grommetRadius
        self.grommetOutlineWidth = grommetOutlineWidth
        self.grommetBorderWidth = 1
        self.fillColor = fillColor
        self.grommetOutlineColor = outlineColor
        self.borderColor = borderColor

    @property
    def cornerGrommets(self):
        return int(self._cornerGrommets * 72)  # ft -> px (72 dpi * 12in handled: legacy used *72)

    @cornerGrommets.setter
    def cornerGrommets(self, value):
        if value > 1 or not isinstance(value, (int, float)):
            self._cornerGrommets = 0.75
        else:
            self._cornerGrommets = round(value, 3)

    @property
    def ImageInstance(self):
        return self._ImageInstance

    @ImageInstance.setter
    def ImageInstance(self, image):
        if isinstance(image, Image.Image):
            if image.mode != "RGB":
                image = image.convert("RGB")
            self._ImageInstance = image
            self.width, self.height = image.size
        else:
            self._ImageInstance = None

    def getCornerGrommetPositions(self):
        return [
            (self.cornerGrommets, self.cornerGrommets),
            (self.width - self.cornerGrommets, self.cornerGrommets),
            (self.cornerGrommets, self.height - self.cornerGrommets),
            (self.width - self.cornerGrommets, self.height - self.cornerGrommets),
        ]

    def getSideGrommetsPositions(self, length, grommetCounts, side=None):
        if not side:
            raise ValueError("Side must be 'top', 'bottom', 'left', or 'right'.")
        positions = []
        mode = "horizontal" if side in ("top", "bottom") else "vertical"
        grommetPixelSpacing = (length - 2 * self.cornerGrommets) / (grommetCounts - 1)
        for i in range(grommetCounts):
            match side:
                case "top" | "left":
                    anchor = self.cornerGrommets
                case "bottom":
                    anchor = self.height - self.cornerGrommets
                case "right":
                    anchor = self.width - self.cornerGrommets
                case _:
                    raise ValueError("Side must be 'top', 'bottom', 'left', or 'right'.")
            if mode == "horizontal":
                positions.append((self.cornerGrommets + i * grommetPixelSpacing, anchor))
            else:
                positions.append((anchor, self.cornerGrommets + i * grommetPixelSpacing))
        return positions

    def getGrommetPositions(self, sides=None, widthGrommetsCounts=2, heightGrommetsCounts=2):
        corner = self.getCornerGrommetPositions()
        positions = set()
        for side in sides or []:
            match side:
                case "top":
                    if widthGrommetsCounts == 2:
                        positions.update((corner[0], corner[1]))
                    elif widthGrommetsCounts > 2:
                        positions.update(self.getSideGrommetsPositions(self.width, widthGrommetsCounts, "top"))
                case "bottom":
                    if widthGrommetsCounts == 2:
                        positions.update((corner[2], corner[3]))
                    elif widthGrommetsCounts > 2:
                        positions.update(self.getSideGrommetsPositions(self.width, widthGrommetsCounts, "bottom"))
                case "left":
                    if heightGrommetsCounts == 2:
                        positions.update((corner[0], corner[2]))
                    elif heightGrommetsCounts > 2:
                        positions.update(self.getSideGrommetsPositions(self.height, heightGrommetsCounts, "left"))
                case "right":
                    if heightGrommetsCounts == 2:
                        positions.update((corner[1], corner[3]))
                    elif heightGrommetsCounts > 2:
                        positions.update(self.getSideGrommetsPositions(self.height, heightGrommetsCounts, "right"))
        return positions

    def addGrommets(self, sides=None, convertedFileDir=None, sourceFileDir=None,
                    widthGrommetsCounts=2, heightGrommetsCounts=2):
        if convertedFileDir is None:
            raise ValueError("Output file name is not provided.")
        if not os.path.exists(sourceFileDir):
            raise FileNotFoundError(f"File {sourceFileDir} does not exist to add grommets.")

        self.ImageInstance = Image.open(sourceFileDir)
        positions = self.getGrommetPositions(
            sides=sides, widthGrommetsCounts=widthGrommetsCounts,
            heightGrommetsCounts=heightGrommetsCounts)

        # corners drawn once (legacy removed duplicates, then always drew corners)
        cornerPositions = set(self.getCornerGrommetPositions())
        allPositions = cornerPositions | (positions - cornerPositions)
        return self.drawGrommetPoints(allPositions, convertedFileDir)

    def drawGrommetPoints(self, positions, convertedFileDir):
        if self.ImageInstance is None:
            raise ValueError("No image has been loaded to draw grommets on.")
        drawer = ImageDraw.Draw(self.ImageInstance)
        r, ow, bw = self.grommetRadius, self.grommetOutlineWidth, self.grommetBorderWidth
        for (x, y) in positions:
            drawer.ellipse([(x - r - ow - bw, y - r - ow - bw),
                            (x + r + ow + bw, y + r + ow + bw)], fill=self.borderColor)
            drawer.ellipse([(x - r - ow, y - r - ow),
                            (x + r + ow, y + r + ow)], fill=self.grommetOutlineColor)
            drawer.ellipse([(x - r, y - r), (x + r, y + r)], fill=self.fillColor)
        self.ImageInstance.save(convertedFileDir, dpi=(72, 72))
        return True
