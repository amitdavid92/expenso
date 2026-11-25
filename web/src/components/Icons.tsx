import type { SVGProps } from "react";

/**
 * The whole icon set: drawn for this app, one grid (20px), one stroke weight.
 * Icons mark actions and states; none is decoration.
 */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

type Props = SVGProps<SVGSVGElement>;

export const AttachIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M15.5 9.5 10 15a3.2 3.2 0 0 1-4.5-4.5l6-6a2.1 2.1 0 0 1 3 3l-6 6a1 1 0 0 1-1.5-1.5L12.5 6.5" />
  </Icon>
);

export const SendIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M10 16V4.5M5 9l5-5 5 5" />
  </Icon>
);

export const CheckIcon = (p: Props) => (
  <Icon {...p}>
    <path d="m4.5 10.5 3.5 3.5 7.5-8" />
  </Icon>
);

export const AlertIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M10 3.2 17.5 16h-15L10 3.2Z" />
    <path d="M10 8v3.6M10 13.7v.1" />
  </Icon>
);

export const StopIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="7" />
    <path d="m5.2 5.2 9.6 9.6" />
  </Icon>
);

export const RetryIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M16 10a6 6 0 1 1-1.9-4.4" />
    <path d="M16.3 3.2v3.3H13" />
  </Icon>
);

export const CloseIcon = (p: Props) => (
  <Icon {...p}>
    <path d="m5 5 10 10M15 5 5 15" />
  </Icon>
);

/** A slip with a torn lower edge: the product's own mark, and the upload affordance. */
export const SlipIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M5 3.5h10v13l-2-1.4-1.5 1.4-1.5-1.4-1.5 1.4L7 15.1l-2 1.4v-13Z" />
    <path d="M7.8 7.2h4.4M7.8 10h4.4" />
  </Icon>
);

export const EditIcon = (p: Props) => (
  <Icon {...p}>
    <path d="m4 16 .7-3.2 8.6-8.6a1.5 1.5 0 0 1 2.1 0l.4.4a1.5 1.5 0 0 1 0 2.1l-8.6 8.6L4 16Z" />
  </Icon>
);

export const PlaneIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M17 3 2.8 8.6l4.6 2 1.9 5.2 2.4-3.4 3.6 2.6L17 3Z" />
    <path d="m7.4 10.6 6.1-4.4" />
  </Icon>
);

export const CameraIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M3 7.2A1.7 1.7 0 0 1 4.7 5.5h1.6l1.2-1.8h5l1.2 1.8h1.6A1.7 1.7 0 0 1 17 7.2v7.1a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 14.3V7.2Z" />
    <circle cx="10" cy="10.6" r="2.9" />
  </Icon>
);

export const ShieldIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M10 2.8 4 5v4.6c0 3.6 2.4 6.3 6 7.6 3.6-1.3 6-4 6-7.6V5l-6-2.2Z" />
    <path d="m7.4 9.9 1.9 1.9 3.4-3.7" />
  </Icon>
);

export const BarsIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M3.5 16.5h13M6 16.5v-5M10 16.5v-10M14 16.5V9" />
  </Icon>
);

export const ArrowIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M4.5 10h11M11 5.5l4.5 4.5-4.5 4.5" />
  </Icon>
);

export const NewIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M10 4.5v11M4.5 10h11" />
  </Icon>
);

export const DiscardIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M4.5 6h11M8 6V4.2h4V6M6 6l.6 9.8h6.8L14 6" />
  </Icon>
);
