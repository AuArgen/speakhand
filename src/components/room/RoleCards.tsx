// Роль тандоо: эки чоң иллюстрацияланган карта.
import type { Role } from "../../lib/room";
import { ArtSigner, ArtSpeaker } from "./roomIcons";

export const ROLE_LABEL: Record<Role, string> = { speaker: "Мен сүйлөйм", signer: "Мен жаңсайм" };
export const ROLE_SHORT: Record<Role, string> = { speaker: "сүйлөйт", signer: "жаңсайт" };
export const ROLE_DESC: Record<Role, string> = {
  speaker: "Сүйлөйм же жазам — экинчи адамга текст жана 3D аватар жест менен көрсөтөт",
  signer: "Жест тилинде сүйлөйм — экинчи адамга текст чыгып, үн менен окулат",
};

export function RoleCards(props: { value: Role | null; onPick: (r: Role) => void; suggest?: Role | null; disabled?: boolean; busy?: Role | null }) {
  const roles: Role[] = ["speaker", "signer"];
  return (
    <div className="role-cards" role="radiogroup" aria-label="Сиз кимсиз?">
      {roles.map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={props.value === r}
          className={`role-card ${r} ${props.value === r ? "selected" : ""}`}
          onClick={() => props.onPick(r)}
          disabled={props.disabled}
        >
          {props.suggest === r && <span className="role-suggest">Сунушталат</span>}
          <span className="role-art">{r === "speaker" ? <ArtSpeaker /> : <ArtSigner />}</span>
          <span className="role-name">{ROLE_LABEL[r]}</span>
          <span className="role-desc">{r === "signer" ? "жест тили" : "үн менен"}</span>
          {props.busy === r && <span className="role-busy"><span className="spinner" /></span>}
        </button>
      ))}
    </div>
  );
}
