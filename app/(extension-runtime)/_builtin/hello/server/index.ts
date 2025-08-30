import host from '@ext/host';

async function greet(name: string): Promise<string> {
  const stamp = new Date().toISOString();
  console.log(`[builtin/hello] greet from ${host.extensionId} at ${stamp}`);
  return `Hello, ${name}! Signed: the server at ${stamp}.`;
}

async function echo(message: string): Promise<string> {
  return `echo: ${message}`;
}

export const actions = {
  'greeter.greet': greet,
  'listener.echo': echo,
};
