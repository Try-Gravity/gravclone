# Ad Variants

gravclone supports all 23 variants from the `@gravity-ai/react` SDK. Switch between them in real time using the floating picker in the bottom-right corner of any clone.

## Recommended by context

### Chat / conversation interfaces
| Variant | Description |
|---------|-------------|
| `suggestion` | "You might also want to try" pill with favicon + title — feels like a native suggestion |
| `inline` | Compact card with AD badge, title, description, CTA button |
| `minimal` | Ultra-clean single line |

### Content / article sites
| Variant | Description |
|---------|-------------|
| `native` | Blends with editorial content |
| `contextual` | Matches surrounding text style |
| `quote` | Styled as a blockquote |
| `footnote` | Small text at the bottom |

### Prominent placement
| Variant | Description |
|---------|-------------|
| `card` | Full card with border, shadow, title, description, CTA |
| `accent` | Card with a colored accent bar at the top |
| `split-action` | Two-column layout with content + CTA |
| `spotlight` | Large featured placement |

### Compact / utility
| Variant | Description |
|---------|-------------|
| `pill` | Tiny rounded pill |
| `banner` | Full-width strip |
| `toolbar` | Toolbar-style bar |
| `notification` | Toast-style notification |
| `tooltip` | Hover-style tooltip card |
| `divider` | Inline divider with ad content |
| `compact-bar` | Single-row bar |

### Inline text
| Variant | Description |
|---------|-------------|
| `text-link` | Favicon + brand + blue linked text — best embedded in prose |
| `hyperlink` | Simple blue link with AD badge |

### Other
| Variant | Description |
|---------|-------------|
| `bubble` | Chat bubble style |
| `labeled` | Labeled card with header |
| `embed` | Embeddable widget |
| `side-panel` | Side panel layout |

## Dark mode

All variants automatically detect dark mode via `<html class="dark">` and render with appropriate colors. The `theme` prop is passed to `GravityAd` based on the document's class list.

## Preview all variants

Visit the official sandbox to see every variant rendered live:

https://react-sandbox.trygravity.ai/
