// The profile's image-input setting (`AgentSelection.imageInput`) as a select
// offers it: unset is a choice of its own, "ask the endpoint", beside the two
// answers a person can pin.
//
// NODE-FREE: profile forms run in the browser and import this by path.

export type ImageInputChoice = 'auto' | 'yes' | 'no'

export const IMAGE_INPUT_OPTIONS: { value: ImageInputChoice; label: string }[] = [
  { value: 'auto', label: 'Ask the endpoint' },
  { value: 'yes', label: 'Takes images' },
  { value: 'no', label: 'Text only' },
]

export function imageInputChoice(imageInput: boolean | undefined): ImageInputChoice {
  return imageInput === undefined ? 'auto' : imageInput ? 'yes' : 'no'
}

export function imageInputFromChoice(choice: string): boolean | undefined {
  return choice === 'auto' ? undefined : choice === 'yes'
}
