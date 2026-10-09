import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";

it("keeps white selected-mode text above AA in both themes", async () => {
  const css = await readFile("src/index.css", "utf8");
  // One inherited token is intentionally shared by light and dark modes.
  const tokens = [...css.matchAll(/--mode-selected:\s*oklch\((?<lightness>[\d.]+) (?<chroma>[\d.]+) (?<hue>[\d.]+)\)/gu)];
  expect(tokens).toHaveLength(1);
  const lightness = Number(tokens[0]?.groups?.lightness);
  const chroma = Number(tokens[0]?.groups?.chroma);
  const hue = Number(tokens[0]?.groups?.hue);
  const axisA = chroma * Math.cos(hue * Math.PI / 180);
  const axisB = chroma * Math.sin(hue * Math.PI / 180);
  const long = (lightness + 0.3963377774 * axisA + 0.2158037573 * axisB) ** 3;
  const medium = (lightness - 0.1055613458 * axisA - 0.0638541728 * axisB) ** 3;
  const short = (lightness - 0.0894841775 * axisA - 1.291485548 * axisB) ** 3;
  const [red = 0, green = 0, blue = 0] = [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ].map((channel) => Math.max(0, Math.min(1, channel)));
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const contrast = 1.05 / (luminance + 0.05);
  expect(contrast).toBeGreaterThanOrEqual(4.5);
});
