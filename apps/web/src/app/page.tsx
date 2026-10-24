export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-medium uppercase tracking-wide text-stone-500">
        Early development
      </p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">
        Visual Furniture Sourcing Agent
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-stone-600">
        Upload a photo of a piece of furniture from any source, and the agent
        will find candidate Alibaba listings, compare their design similarity,
        and return ranked products with seller information.
      </p>
    </main>
  );
}
