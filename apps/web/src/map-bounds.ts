export type Coordinate = [number, number];
export type CoordinateBounds = [Coordinate, Coordinate];

export function boundsForCoordinates(
  coordinates: Coordinate[],
): CoordinateBounds | null {
  if (!coordinates.length) return null;

  const latitudes = coordinates.map((coordinate) => coordinate[1]);
  const longitudes = coordinates
    .map((coordinate) => ((coordinate[0] % 360) + 360) % 360)
    .sort((left, right) => left - right);

  let largestGap = -1;
  let gapIndex = 0;
  for (let index = 0; index < longitudes.length; index += 1) {
    const current = longitudes[index] as number;
    const next =
      index === longitudes.length - 1
        ? (longitudes[0] as number) + 360
        : (longitudes[index + 1] as number);
    if (next - current > largestGap) {
      largestGap = next - current;
      gapIndex = index;
    }
  }

  const start = longitudes[(gapIndex + 1) % longitudes.length] as number;
  let end = longitudes[gapIndex] as number;
  if (end < start) end += 360;
  const west = ((start + 180) % 360) - 180;
  const east = west + (end - start);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);

  return [
    [west, south],
    [east, north],
  ];
}
