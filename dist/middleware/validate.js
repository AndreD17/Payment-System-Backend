export const validate = (schema) => (req, _res, next) => {
    const parsed = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!parsed.success) {
        return next({ status: 400, message: "Validation error", details: parsed.error.flatten() });
    }
    next();
};
