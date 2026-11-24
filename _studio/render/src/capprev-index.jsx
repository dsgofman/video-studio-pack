// DEV-ONLY caption preview harness. Renders each cue KIND's entrance over a neutral gradient using
// the REAL <Cues>/<CueText> components (imported from Video.jsx) and the REAL frame-windows
// (pre-resolved by render/cues.mjs in the driver script) — so what you see here is exactly what the
// production render draws, minus images/audio. No API, no assets. Driven entirely by inputProps.
import { registerRoot, Composition, AbsoluteFill, Sequence } from 'remotion';
import { Cues, Caption, FontFaces } from './Video.jsx';

const BG = ['linear-gradient(135deg,#3c4a54,#1d2730 55%,#4a382b)',
  'linear-gradient(135deg,#4a382b,#241a12 55%,#3c2a1c)',
  'linear-gradient(135deg,#2b3a4a,#141d27 55%,#2a3c3a)',
  'linear-gradient(135deg,#453040,#20141d 55%,#3a2430)',
  'linear-gradient(135deg,#3a3c2b,#1d1f12 55%,#2a2c1c)'];

function CapPreview({ beats, captionStyle }) {
  const list = beats || [];
  const starts = []; { let o = 0; for (const b of list) { starts.push(o); o += b.durationInFrames; } }
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <FontFaces />
      {list.map((b, i) => (
        <Sequence key={i} from={starts[i]} durationInFrames={b.durationInFrames}>
          <AbsoluteFill style={{ background: BG[i % BG.length] }} />
          {/* tiny kind label so the filmstrip is self-documenting (not a caption) */}
          <div style={{ position: 'absolute', left: 18, bottom: 12, fontFamily: 'monospace', fontSize: 22, color: 'rgba(255,255,255,0.5)' }}>{b.tag || ''}</div>
          {b.caption
            ? <Caption caption={b.caption} dur={b.durationInFrames} cstyle={captionStyle} />
            : <Cues cues={b.cues} cstyle={captionStyle} />}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

registerRoot(() => (
  <Composition
    id="capprev"
    component={CapPreview}
    durationInFrames={300}
    fps={30}
    width={1280}
    height={720}
    defaultProps={{ beats: [] }}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(1, (props.beats || []).reduce((a, b) => a + (b.durationInFrames || 0), 0)),
      fps: 30, width: 1280, height: 720,
    })}
  />
));
