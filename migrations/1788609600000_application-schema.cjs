exports.up = (pgm) => {
  pgm.createSchema("upcoming");
};
exports.down = (pgm) => {
  // No CASCADE: refuse rollback if later migrations still have objects here.
  pgm.dropSchema("upcoming");
};
