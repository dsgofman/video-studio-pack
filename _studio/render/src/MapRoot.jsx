import { Composition } from 'remotion';
import { MapStill } from './Map.jsx';

export const MapRoot = () => (
  <Composition
    id="map"
    component={MapStill}
    durationInFrames={1}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ rotateLng: 0, focus: [[0, 0]], arcs: [], labels: [] }}
  />
);
