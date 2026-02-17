export function errorHandler(err, _req, res, _next) {
    const status = Number(err?.status ?? 500);
    res.status(status).json({ message: err?.message ?? "Server error", details: err?.details });
}
