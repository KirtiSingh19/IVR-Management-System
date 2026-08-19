/**
 * An audio picker, ported from js/audio-picker.js.
 *
 * Two behaviours carried over deliberately:
 *
 *   - Names match case-insensitively, because the unique index on
 *     audio_files.name uses a case-insensitive collation. Without this an IVR
 *     saved against "Invalid.wav" is told its prompt is missing when the library
 *     holds "invalid.wav".
 *   - A prompt that was assigned and has since been deleted still appears, marked
 *     as missing. Dropping it would mean opening the form and saving it silently
 *     cleared the assignment without anyone choosing to.
 */
import { useEffect, useState } from 'react';
import { AudioRepo } from '../services/repo.js';

export default function AudioSelect({ id, value, onChange, emptyLabel = 'No audio' }) {
  const [files, setFiles] = useState([]);

  useEffect(() => {
    let cancelled = false;
    AudioRepo.all().then((all) => {
      if (!cancelled) setFiles(all);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const wanted = String(value ?? '').trim().toLowerCase();
  const known = files.some((file) => file.name.toLowerCase() === wanted);

  return (
    <select className="form-select" id={id} value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
      <option value="">{emptyLabel}</option>
      {wanted && !known ? <option value={value}>{value} (missing from the library)</option> : null}
      {files.map((file) => (
        <option key={file.id} value={file.name}>
          {file.name}
        </option>
      ))}
    </select>
  );
}
